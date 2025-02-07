import { Api } from "../tl/api.js";
import { getDisplayName } from "../utils.ts";
import { sleep } from "../helpers.ts";
import { computeCheck } from "../password.ts";
import { AbstractTelegramClient } from "./abstract_telegram_client.ts";
import {
  ApiCredentials,
  BotAuthParams,
  QrCodeAuthParams,
  UserAuthParams,
  UserPasswordAuthParams,
} from "./types.ts";

const QR_CODE_TIMEOUT = 30000;

export async function start(
  client: AbstractTelegramClient,
  authParams?: UserAuthParams | BotAuthParams,
) {
  if (!client.connected) {
    await client.connect();
  }

  if (await client.checkAuthorization()) {
    return;
  }

  if (!authParams) {
    throw new Error("Not enough details to sign in");
  }

  const apiCredentials = {
    apiId: client.apiId,
    apiHash: client.apiHash,
  };

  await _authFlow(client, apiCredentials, authParams);
}

export async function checkAuthorization(client: AbstractTelegramClient) {
  try {
    await client.invoke(new Api.updates.GetState());
    return true;
  } catch (_e) {
    return false;
  }
}

export async function signInUser(
  client: AbstractTelegramClient,
  apiCredentials: ApiCredentials,
  authParams: UserAuthParams,
): Promise<Api.TypeUser> {
  let phoneNumber;
  let phoneCodeHash;
  let isCodeViaApp = false;

  while (1) {
    try {
      if (typeof authParams.phoneNumber === "function") {
        try {
          phoneNumber = await authParams.phoneNumber();
        } catch (err) {
          if (err.errorMessage === "RESTART_AUTH_WITH_QR") {
            return client.signInUserWithQrCode(
              apiCredentials,
              authParams,
            );
          }

          throw err;
        }
      } else {
        phoneNumber = authParams.phoneNumber;
      }
      const sendCodeResult = await client.sendCode(
        apiCredentials,
        phoneNumber,
        authParams.forceSMS,
      );
      phoneCodeHash = sendCodeResult.phoneCodeHash;
      isCodeViaApp = sendCodeResult.isCodeViaApp;

      if (typeof phoneCodeHash !== "string") {
        throw new Error("Failed to retrieve phone code hash");
      }

      break;
    } catch (err) {
      if (typeof authParams.phoneNumber !== "function") {
        throw err;
      }

      const shouldWeStop = await authParams.onError(err);
      if (shouldWeStop) {
        throw new Error("AUTH_USER_CANCEL");
      }
    }
  }

  let phoneCode;
  let isRegistrationRequired = false;
  let termsOfService;

  while (1) {
    try {
      try {
        phoneCode = await authParams.phoneCode(isCodeViaApp);
      } catch (err) {
        // This is the support for changing phone number from the phone code screen.
        if (err.errorMessage === "RESTART_AUTH") {
          return client.signInUser(apiCredentials, authParams);
        }
      }

      if (!phoneCode) {
        throw new Error("Code is empty");
      }

      // May raise PhoneCodeEmptyError, PhoneCodeExpiredError,
      // PhoneCodeHashEmptyError or PhoneCodeInvalidError.
      const result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode,
        }),
      );

      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        isRegistrationRequired = true;
        termsOfService = result.termsOfService;
        break;
      }

      return result.user;
    } catch (err) {
      if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
        return client.signInWithPassword(apiCredentials, authParams);
      } else {
        const shouldWeStop = await authParams.onError(err);
        if (shouldWeStop) {
          throw new Error("AUTH_USER_CANCEL");
        }
      }
    }
  }

  if (isRegistrationRequired) {
    while (1) {
      try {
        let lastName;
        let firstName = "first name";
        if (authParams.firstAndLastNames) {
          const result = await authParams.firstAndLastNames();
          firstName = result[0];
          lastName = result[1];
        }
        if (!firstName) {
          throw new Error("First name is required");
        }

        const { user } = (await client.invoke(
          new Api.auth.SignUp({
            phoneNumber,
            phoneCodeHash,
            firstName,
            lastName,
          }),
        )) as Api.auth.Authorization;

        if (termsOfService) {
          // This is a violation of Telegram rules: the user should be presented with and accept TOS.
          await client.invoke(
            new Api.help.AcceptTermsOfService({
              id: termsOfService.id,
            }),
          );
        }

        return user;
      } catch (err) {
        const shouldWeStop = await authParams.onError(err);
        if (shouldWeStop) {
          throw new Error("AUTH_USER_CANCEL");
        }
      }
    }
  }

  await authParams.onError(new Error("Auth failed"));
  return client.signInUser(apiCredentials, authParams);
}

export async function signInUserWithQrCode(
  client: AbstractTelegramClient,
  apiCredentials: ApiCredentials,
  authParams: QrCodeAuthParams,
): Promise<Api.TypeUser> {
  let isScanningComplete = false;
  if (authParams.qrCode === undefined) {
    throw new Error("qrCode callback is not defined");
  }
  const inputPromise = (async () => {
    while (1) {
      if (isScanningComplete) break;
      const result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: Number(apiCredentials.apiId),
          apiHash: apiCredentials.apiHash,
          exceptIds: [],
        }),
      );

      if (!(result instanceof Api.auth.LoginToken)) {
        throw new Error("Unexpected");
      }

      const { token, expires } = result;
      await Promise.race([
        authParams.qrCode!({ token, expires }),
        sleep(QR_CODE_TIMEOUT),
      ]);
      await sleep(QR_CODE_TIMEOUT);
    }
  })();

  const updatePromise = new Promise((resolve) => {
    client.addEventHandler((update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateLoginToken) {
        resolve(undefined);
      }
    });
  });

  try {
    await Promise.race([updatePromise, inputPromise]);
  } catch (err) {
    throw err;
  } finally {
    isScanningComplete = true;
  }

  try {
    const result2 = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: Number(apiCredentials.apiId),
        apiHash: apiCredentials.apiHash,
        exceptIds: [],
      }),
    );
    if (
      result2 instanceof Api.auth.LoginTokenSuccess &&
      result2.authorization instanceof Api.auth.Authorization
    ) {
      return result2.authorization.user;
    } else if (result2 instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result2.dcId);
      const migratedResult = await client.invoke(
        new Api.auth.ImportLoginToken({
          token: result2.token,
        }),
      );

      if (
        migratedResult instanceof Api.auth.LoginTokenSuccess &&
        migratedResult.authorization instanceof Api.auth.Authorization
      ) {
        return migratedResult.authorization.user;
      } else {
        client._log.error(
          `Received unknown result while scanning QR ${result2.className}`,
        );
        throw new Error(
          `Received unknown result while scanning QR ${result2.className}`,
        );
      }
    } else {
      client._log.error(
        `Received unknown result while scanning QR ${result2.className}`,
      );
      throw new Error(
        `Received unknown result while scanning QR ${result2.className}`,
      );
    }
  } catch (err) {
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      return client.signInWithPassword(apiCredentials, authParams);
    }
    throw err;
  }

  // await authParams.onError(new Error("QR auth failed"));
  // throw new Error("QR auth failed");
}

export async function sendCode(
  client: AbstractTelegramClient,
  apiCredentials: ApiCredentials,
  phoneNumber: string,
  forceSMS = false,
): Promise<{
  phoneCodeHash: string;
  isCodeViaApp: boolean;
}> {
  try {
    const { apiId, apiHash } = apiCredentials;
    const sendResult = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );

    // If we already sent a SMS, do not resend the phoneCode (hash may be empty)
    if (!forceSMS || sendResult.type instanceof Api.auth.SentCodeTypeSms) {
      return {
        phoneCodeHash: sendResult.phoneCodeHash,
        isCodeViaApp: sendResult.type instanceof Api.auth.SentCodeTypeApp,
      };
    }

    const resendResult = await client.invoke(
      new Api.auth.ResendCode({
        phoneNumber,
        phoneCodeHash: sendResult.phoneCodeHash,
      }),
    );

    return {
      phoneCodeHash: resendResult.phoneCodeHash,
      isCodeViaApp: resendResult.type instanceof Api.auth.SentCodeTypeApp,
    };
  } catch (err) {
    if (err.errorMessage === "AUTH_RESTART") {
      return client.sendCode(apiCredentials, phoneNumber, forceSMS);
    } else {
      throw err;
    }
  }
}

export async function signInWithPassword(
  client: AbstractTelegramClient,
  _apiCredentials: ApiCredentials,
  authParams: UserPasswordAuthParams,
): Promise<Api.TypeUser> {
  let emptyPassword = false;
  while (1) {
    try {
      const passwordSrpResult = await client.invoke(
        new Api.account.GetPassword(),
      );
      if (!authParams.password) {
        emptyPassword = true;
        break;
      }

      const password = await authParams.password(passwordSrpResult.hint);
      if (!password) {
        throw new Error("Password is empty");
      }

      const passwordSrpCheck = computeCheck(
        passwordSrpResult,
        password,
      );
      const { user } = (await client.invoke(
        new Api.auth.CheckPassword({
          password: passwordSrpCheck,
        }),
      )) as Api.auth.Authorization;

      return user;
    } catch (err) {
      const shouldWeStop = await authParams.onError(err);
      if (shouldWeStop) {
        throw new Error("AUTH_USER_CANCEL");
      }
    }
  }
  if (emptyPassword) {
    throw new Error("Account has 2FA enabled.");
  }
  return undefined!; // Never reached (TypeScript fix)
}

export async function signInBot(
  client: AbstractTelegramClient,
  apiCredentials: ApiCredentials,
  authParams: BotAuthParams,
) {
  const { apiId, apiHash } = apiCredentials;
  let { botAuthToken } = authParams;
  if (!botAuthToken) {
    throw new Error("a valid BotToken is required");
  }
  if (typeof botAuthToken === "function") {
    let token;
    while (true) {
      token = botAuthToken();
      if (token) {
        botAuthToken = token;
        break;
      }
    }
  }

  const { user } = (await client.invoke(
    new Api.auth.ImportBotAuthorization({
      apiId,
      apiHash,
      botAuthToken,
    }),
  )) as Api.auth.Authorization;
  return user;
}

export async function _authFlow(
  client: AbstractTelegramClient,
  apiCredentials: ApiCredentials,
  authParams: UserAuthParams | BotAuthParams,
) {
  const me = "phoneNumber" in authParams
    ? await client.signInUser(apiCredentials, authParams)
    : await client.signInBot(apiCredentials, authParams);

  client._log.info("Signed in successfully as " + getDisplayName(me));
}
