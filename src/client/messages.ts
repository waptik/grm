import { Api } from "../tl/api.js";
import { groupBy, isArrayLike, TotalList } from "../helpers.ts";
import { EntityType_, entityType_ } from "../tl/helpers.ts";
import { AbstractTelegramClient } from "./abstract_telegram_client.ts";
import { RequestIter } from "../request_iter.ts";
import {
  chunks,
  getInputMedia,
  getInputPeer,
  getMessageId,
  getPeerId,
  parseID,
} from "../utils.ts";
import { bigInt } from "../../deps.ts";
import { _getPeer } from "./users.ts";
import { _parseMessageText } from "./message_parse.ts";
import { _fileToMedia } from "./utils.ts";
import {
  EditMessageParams,
  ForwardMessagesParams,
  IterMessagesParams,
  MarkAsReadParams,
  MessageIterParams,
  SendMessageParams,
  UpdatePinMessageParams,
} from "./types.ts";

const MAX_CHUNK_SIZE = 100;

export class _MessagesIter extends RequestIter {
  entity?: Api.TypeInputPeer;
  request?:
    | Api.messages.SearchGlobal
    | Api.messages.GetReplies
    | Api.messages.GetHistory
    | Api.messages.Search;
  addOffset?: number;
  maxId?: number;
  minId?: number;
  lastId?: number;

  async _init({
    entity,
    offsetId,
    minId,
    maxId,
    fromUser,
    offsetDate,
    addOffset,
    filter,
    search,
    replyTo,
  }: MessageIterParams) {
    if (entity) {
      this.entity = await this.client.getInputEntity(entity);
    } else {
      this.entity = undefined;
      if (this.reverse) {
        throw new Error("Cannot reverse global search");
      }
    }
    if (this.reverse) {
      offsetId = Math.max(offsetId, minId);
      if (offsetId && maxId) {
        if (maxId - offsetId <= 1) {
          return false;
        }
      }
      if (!maxId) {
        maxId = Number.MAX_SAFE_INTEGER;
      }
    } else {
      offsetId = Math.max(offsetId, maxId);
      if (offsetId && minId) {
        if (offsetId - minId <= 1) {
          return false;
        }
      }
    }
    if (this.reverse) {
      if (offsetId) {
        offsetId += 1;
      } else if (!offsetDate) {
        offsetId = 1;
      }
    }
    if (fromUser) {
      fromUser = await this.client.getInputEntity(fromUser);
    }

    if (!this.entity && fromUser) {
      this.entity = new Api.InputPeerEmpty();
    }
    if (!filter) {
      filter = new Api.InputMessagesFilterEmpty();
    }
    if (!this.entity) {
      this.request = new Api.messages.SearchGlobal({
        q: search || "",
        filter: filter,
        minDate: undefined,
        // TODO fix this smh
        maxDate: offsetDate,
        offsetRate: undefined,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: offsetId,
        limit: 1,
      });
    } else if (replyTo !== undefined) {
      this.request = new Api.messages.GetReplies({
        peer: this.entity,
        msgId: replyTo,
        offsetId: offsetId,
        offsetDate: offsetDate,
        addOffset: addOffset,
        limit: 0,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
      });
    } else if (
      search !== undefined ||
      !(filter instanceof Api.InputMessagesFilterEmpty) ||
      fromUser !== undefined
    ) {
      this.request = new Api.messages.Search({
        peer: this.entity,
        q: search || "",
        filter: typeof filter === "function" ? new filter() : filter,
        minDate: undefined,
        maxDate: offsetDate,
        offsetId: offsetId,
        addOffset: addOffset,
        limit: 0,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
        fromId: fromUser,
      });
      if (
        filter instanceof Api.InputMessagesFilterEmpty &&
        offsetDate &&
        !search &&
        !offsetId
      ) {
        for await (
          const m of this.client.iterMessages(this.entity, {
            limit: 1,
            offsetDate: offsetDate,
          })
        ) {
          this.request.offsetId = m.id + 1;
        }
      }
    } else {
      this.request = new Api.messages.GetHistory({
        peer: this.entity,
        limit: 1,
        offsetDate: offsetDate,
        offsetId: offsetId,
        minId: 0,
        maxId: 0,
        addOffset: addOffset,
        hash: bigInt.zero,
      });
    }
    if (this.limit <= 0) {
      const result = await this.client.invoke(this.request);
      if (result instanceof Api.messages.MessagesNotModified) {
        this.total = result.count;
      } else {
        if ("count" in result) {
          this.total = result.count;
        } else {
          this.total = result.messages.length;
        }
      }
      return false;
    }
    if (!this.waitTime) {
      this.waitTime = this.limit > 3000 ? 1 : 0;
    }
    if (
      this.reverse &&
      !(this.request instanceof Api.messages.SearchGlobal)
    ) {
      this.request.addOffset -= MAX_CHUNK_SIZE;
    }
    this.addOffset = addOffset;
    this.maxId = maxId;
    this.minId = minId;
    this.lastId = this.reverse ? 0 : Number.MAX_SAFE_INTEGER;
  }

  async _loadNextChunk() {
    if (!this.request) {
      throw new Error("Request not set yet");
    }
    this.request.limit = Math.min(this.left, MAX_CHUNK_SIZE);
    if (this.reverse && this.request.limit != MAX_CHUNK_SIZE) {
      if (!(this.request instanceof Api.messages.SearchGlobal)) {
        this.request.addOffset = this.addOffset! - this.request.limit;
      }
    }

    const r = await this.client.invoke(this.request);
    if (r instanceof Api.messages.MessagesNotModified) {
      return true;
    }
    if ("count" in r) {
      this.total = r.count;
    } else {
      this.total = r.messages.length;
    }

    const entities = new Map();

    for (const x of [...r.users, ...r.chats]) {
      entities.set(getPeerId(x), x);
    }
    const messages: Api.Message[] = this.reverse
      ? (r.messages.reverse() as unknown as Api.Message[])
      : (r.messages as unknown as Api.Message[]);
    for (const message of messages) {
      if (!this._messageInRange(message)) {
        return true;
      }
      this.lastId = message.id;
      try {
        // if this fails it shouldn't be a big problem
        message._finishInit(this.client, entities, this.entity);
      } catch (_e) {
        //
      }
      message._entities = entities;
      this.buffer?.push(message);
    }
    if (r.messages.length < this.request.limit) {
      return true;
    }

    if (this.buffer) {
      this._updateOffset(this.buffer[this.buffer.length - 1], r);
    } else {
      return true;
    }
  }

  _messageInRange(message: Api.Message) {
    if (this.entity) {
      if (this.reverse) {
        if (message.id <= this.lastId! || message.id >= this.maxId!) {
          return false;
        }
      } else {
        if (message.id >= this.lastId! || message.id <= this.minId!) {
          return false;
        }
      }
    }
    return true;
  }

  // deno-lint-ignore no-explicit-any
  [Symbol.asyncIterator](): AsyncIterator<Api.Message, any, undefined> {
    return super[Symbol.asyncIterator]();
  }

  // deno-lint-ignore no-explicit-any
  _updateOffset(lastMessage: Api.Message, response: any) {
    if (!this.request) {
      throw new Error("Request not set yet");
    }
    this.request.offsetId = Number(lastMessage.id);
    if (this.reverse) {
      this.request.offsetId += 1;
    }
    if (this.request instanceof Api.messages.Search) {
      this.request.maxDate = -1;
    } else {
      if (!(this.request instanceof Api.messages.SearchGlobal)) {
        this.request.offsetDate = lastMessage.date!;
      }
    }
    if (this.request instanceof Api.messages.SearchGlobal) {
      if (lastMessage.inputChat) {
        this.request.offsetPeer = lastMessage.inputChat;
      } else {
        this.request.offsetPeer = new Api.InputPeerEmpty();
      }
      this.request.offsetRate = response.nextRate;
    }
  }
}

interface IDsIterInterface {
  entity: Api.TypeEntityLike;
  ids: Api.TypeInputMessage[];
}

export class _IDsIter extends RequestIter {
  _ids?: Api.TypeInputMessage[];
  _offset?: number;
  _ty: number | undefined;
  private _entity: Api.TypeInputPeer | undefined;

  async _init({ entity, ids }: IDsIterInterface) {
    this.total = ids.length;
    this._ids = this.reverse ? ids.reverse() : ids;
    this._offset = 0;
    this._entity = entity
      ? await this.client.getInputEntity(entity)
      : undefined;
    this._ty = this._entity ? entityType_(this._entity) : undefined;

    if (!this.waitTime) {
      this.waitTime = this.limit > 300 ? 10 : 0;
    }
  }

  // deno-lint-ignore no-explicit-any
  [Symbol.asyncIterator](): AsyncIterator<Api.Message, any, undefined> {
    return super[Symbol.asyncIterator]();
  }

  async _loadNextChunk() {
    const ids = this._ids!.slice(
      this._offset,
      this._offset! + MAX_CHUNK_SIZE,
    );
    if (!ids.length) {
      return false;
    }
    this._offset! += MAX_CHUNK_SIZE;
    let fromId;
    let r;
    if (this._ty == EntityType_.CHANNEL) {
      try {
        r = await this.client.invoke(
          new Api.channels.GetMessages({
            channel: this._entity,
            id: ids,
          }),
        );
      } catch (e) {
        if (e.errorMessage == "MESSAGE_IDS_EMPTY") {
          r = new Api.messages.MessagesNotModified({
            count: ids.length,
          });
        } else {
          throw e;
        }
      }
    } else {
      r = await this.client.invoke(
        new Api.messages.GetMessages({ id: ids }),
      );
      if (this._entity) {
        fromId = await _getPeer(this.client, this._entity);
      }
    }
    if (r instanceof Api.messages.MessagesNotModified) {
      this.buffer?.push(...Array(ids.length));
      return;
    }
    const entities = new Map();
    for (const entity of [...r.users, ...r.chats]) {
      entities.set(getPeerId(entity), entity);
    }
    let message: Api.TypeMessage;
    for (message of r.messages) {
      if (
        message instanceof Api.MessageEmpty ||
        (fromId &&
          getPeerId(message.peerId) !== getPeerId(fromId))
      ) {
        this.buffer?.push(undefined);
      } else {
        const temp: Api.Message = message as unknown as Api.Message;
        temp._finishInit(this.client, entities, this._entity);
        temp._entities = entities;
        this.buffer?.push(temp);
      }
    }
  }
}

const IterMessagesDefaults: IterMessagesParams = {
  limit: undefined,
  offsetDate: undefined,
  offsetId: 0,
  maxId: 0,
  minId: 0,
  addOffset: 0,
  search: undefined,
  filter: undefined,
  fromUser: undefined,
  waitTime: undefined,
  ids: undefined,
  reverse: false,
  replyTo: undefined,
  scheduled: false,
};

export function iterMessages(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike | undefined,
  options: Partial<IterMessagesParams>,
) {
  const {
    limit,
    offsetDate,
    offsetId,
    maxId,
    minId,
    addOffset,
    search,
    filter,
    fromUser,
    waitTime,
    ids,
    reverse,
    replyTo,
  } = { ...IterMessagesDefaults, ...options };
  if (ids) {
    let idsArray;
    if (!isArrayLike(ids)) {
      idsArray = [ids];
    } else {
      idsArray = ids;
    }
    return new _IDsIter(
      client,
      idsArray.length,
      { reverse: reverse, waitTime: waitTime },
      { entity: entity, ids: idsArray },
    );
  }
  return new _MessagesIter(
    client,
    limit,
    { waitTime: waitTime, reverse: reverse },
    {
      entity: entity,
      offsetId: offsetId,
      minId: minId,
      maxId: maxId,
      fromUser: fromUser,
      offsetDate: offsetDate,
      addOffset: addOffset,
      filter: filter,
      search: search,
      replyTo: replyTo,
    },
  );
}

export async function getMessages(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike | undefined,
  params: Partial<IterMessagesParams>,
): Promise<TotalList<Api.Message>> {
  if (Object.keys(params).length == 1 && params.limit === undefined) {
    if (params.minId === undefined && params.maxId === undefined) {
      params.limit = undefined;
    } else {
      params.limit = 1;
    }
  }

  const it = client.iterMessages(entity, params);
  const ids = params.ids;
  if (ids && !isArrayLike(ids)) {
    for await (const message of it) {
      return [message];
    }
    return [];
  }
  const messages = new TotalList<Api.Message>();
  for await (const message of messages) {
    messages.push(message);
  }
  return messages;
}

export async function sendMessage(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  {
    message,
    replyTo,
    attributes,
    parseMode,
    formattingEntities,
    linkPreview = true,
    file,
    thumb,
    forceDocument,
    clearDraft,
    buttons,
    silent,
    supportStreaming,
    schedule,
    noforwards,
    commentTo,
  }: SendMessageParams = {},
) {
  if (file) {
    return client.sendFile(entity, {
      file: file,
      caption: message
        ? typeof message == "string" ? message : message.message
        : "",
      forceDocument: forceDocument,
      clearDraft: clearDraft,
      replyTo: replyTo,
      attributes: attributes,
      thumb: thumb,
      supportsStreaming: supportStreaming,
      parseMode: parseMode,
      formattingEntities: formattingEntities,
      silent: silent,
      scheduleDate: schedule,
      buttons: buttons,
      noforwards: noforwards,
      commentTo: commentTo,
    });
  }
  entity = await client.getInputEntity(entity);
  if (commentTo !== undefined) {
    const discussionData = await getCommentData(client, entity, commentTo);
    entity = discussionData.entity;
    replyTo = discussionData.replyTo;
  }
  let markup, request;
  if (message && message instanceof Api.Message) {
    if (buttons == undefined) {
      markup = message.replyMarkup;
    } else {
      markup = client.buildReplyMarkup(buttons);
    }
    if (silent == undefined) {
      silent = message.silent;
    }
    if (
      message.media &&
      !(message.media instanceof Api.MessageMediaWebPage)
    ) {
      return client.sendFile(entity, {
        file: message.media,
        caption: message.message,
        silent: silent,
        replyTo: replyTo,
        buttons: markup,
        formattingEntities: message.entities,
        scheduleDate: schedule,
      });
    }
    request = new Api.messages.SendMessage({
      peer: entity,
      message: message.message || "",
      silent: silent,
      replyToMsgId: getMessageId(replyTo),
      replyMarkup: markup,
      entities: message.entities,
      clearDraft: clearDraft,
      noWebpage: !(message.media instanceof Api.MessageMediaWebPage),
      scheduleDate: schedule,
      noforwards: noforwards,
    });
    message = message.message;
  } else {
    if (formattingEntities == undefined) {
      [message, formattingEntities] = await _parseMessageText(
        client,
        message || "",
        parseMode,
      );
    }
    if (!message) {
      throw new Error(
        "The message cannot be empty unless a file is provided",
      );
    }
    request = new Api.messages.SendMessage({
      peer: entity,
      message: message.toString(),
      entities: formattingEntities,
      noWebpage: !linkPreview,
      replyToMsgId: getMessageId(replyTo),
      clearDraft: clearDraft,
      silent: silent,
      replyMarkup: client.buildReplyMarkup(buttons),
      scheduleDate: schedule,
      noforwards: noforwards,
    });
  }
  const result = await client.invoke(request);
  if (result instanceof Api.UpdateShortSentMessage) {
    const msg = new Api.Message({
      id: result.id,
      peerId: await _getPeer(client, entity),
      message: message,
      date: result.date,
      out: result.out,
      media: result.media,
      entities: result.entities,
      replyMarkup: request.replyMarkup,
      ttlPeriod: result.ttlPeriod,
    });

    msg._finishInit(client, new Map(), entity);
    return msg;
  }

  return client._getResponseMessage(request, result, entity) as Api.Message;
}

export async function forwardMessages(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  { messages, fromPeer, silent, schedule, noforwards }: ForwardMessagesParams,
) {
  if (!isArrayLike(messages)) {
    messages = [messages];
  }

  entity = await client.getInputEntity(entity);
  let fromPeerId: string | undefined;
  if (fromPeer) {
    fromPeer = await client.getInputEntity(fromPeer);
    fromPeerId = await client.getPeerId(fromPeer);
  }
  const getKey = (m: string | Api.Message) => {
    if (m instanceof Api.Message) {
      return m.chatId;
    }
    const msgId = parseID(m);

    if (msgId) {
      if (fromPeerId !== undefined) {
        return fromPeerId;
      }
      throw new Error("fromPeer must be given if integer IDs are used");
    } else {
      throw new Error(`Cannot forward ${m}`);
    }
  };
  const sent: Api.Message[] = [];
  for (
    const [_chatId, chunk] of groupBy(messages, getKey) as Map<
      number,
      Api.Message[] | number[]
    >
  ) {
    let chat;
    let numbers: number[] = [];
    if (typeof chunk[0] == "number") {
      chat = fromPeer;
      numbers = chunk as number[];
    } else {
      chat = await chunk[0].getInputChat();
      numbers = (chunk as Api.Message[]).map((m: Api.Message) => m.id);
    }
    chunk.push();
    const request = new Api.messages.ForwardMessages({
      fromPeer: chat,
      id: numbers,
      toPeer: entity,
      silent: silent,
      scheduleDate: schedule,
      noforwards: noforwards,
    });
    const result = await client.invoke(request);
    sent.push(
      client._getResponseMessage(request, result, entity) as Api.Message,
    );
  }
  return sent;
}

export async function editMessage(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  {
    message,
    text,
    parseMode,
    formattingEntities,
    linkPreview = true,
    file,
    forceDocument,
    buttons,
    schedule,
  }: EditMessageParams,
) {
  if (
    typeof message === "number" &&
    typeof text === "undefined" &&
    !file &&
    !schedule
  ) {
    throw Error(
      "You have to provide either file or text or schedule property.",
    );
  }
  entity = await client.getInputEntity(entity);
  let id: number | undefined;
  let markup: Api.TypeReplyMarkup | undefined;
  let entities: Api.TypeMessageEntity[] | undefined;
  let inputMedia: Api.TypeInputMedia | undefined;
  if (file) {
    const { media } = await _fileToMedia(client, {
      file,
      forceDocument,
    });
    inputMedia = media;
  }
  if (message instanceof Api.Message) {
    id = getMessageId(message);
    text = message.message;
    entities = message.entities;
    if (buttons == undefined) {
      markup = message.replyMarkup;
    } else {
      markup = client.buildReplyMarkup(buttons);
    }
    if (message.media) {
      inputMedia = getInputMedia(message.media, { forceDocument });
    }
  } else {
    if (typeof message !== "number") {
      throw Error(
        "editMessageParams.message must be either a number or a Api.Message type",
      );
    }
    id = message;
    if (formattingEntities == undefined) {
      [text, entities] = await _parseMessageText(
        client,
        text || "",
        parseMode,
      );
    } else {
      entities = formattingEntities;
    }
    markup = client.buildReplyMarkup(buttons);
  }
  const request = new Api.messages.EditMessage({
    peer: entity,
    id,
    message: text,
    noWebpage: !linkPreview,
    entities,
    media: inputMedia,
    replyMarkup: markup,
    scheduleDate: schedule,
  });
  const result = await client.invoke(request);
  return client._getResponseMessage(request, result, entity) as Api.Message;
}

export async function deleteMessages(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike | undefined,
  messageIds: Api.TypeMessageIDLike[],
  { revoke = false },
) {
  let ty = EntityType_.USER;
  if (entity) {
    entity = await client.getInputEntity(entity);
    ty = entityType_(entity!);
  }
  const ids: number[] = [];
  for (const messageId of messageIds) {
    if (
      messageId instanceof Api.Message ||
      messageId instanceof Api.MessageService ||
      messageId instanceof Api.MessageEmpty
    ) {
      ids.push(messageId.id);
    } else if (typeof messageId === "number") {
      ids.push(messageId);
    } else {
      throw new Error(`Cannot convert ${messageId} to an integer`);
    }
  }
  const results = [];

  if (ty === EntityType_.CHANNEL) {
    for (const chunk of chunks(ids)) {
      results.push(
        client.invoke(
          new Api.channels.DeleteMessages({
            channel: entity,
            id: chunk,
          }),
        ),
      );
    }
  } else {
    for (const chunk of chunks(ids)) {
      results.push(
        client.invoke(
          new Api.messages.DeleteMessages({
            id: chunk,
            revoke: revoke,
          }),
        ),
      );
    }
  }
  return Promise.all(results);
}

export async function pinMessage(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  message?: Api.TypeMessageIDLike,
  pinMessageParams?: UpdatePinMessageParams,
) {
  return await _pin(
    client,
    entity,
    message,
    false,
    pinMessageParams?.notify,
    pinMessageParams?.pmOneSide,
  );
}

export async function unpinMessage(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  message?: Api.TypeMessageIDLike,
  unpinMessageParams?: UpdatePinMessageParams,
) {
  return await _pin(
    client,
    entity,
    message,
    true,
    unpinMessageParams?.notify,
    unpinMessageParams?.pmOneSide,
  );
}

export async function _pin(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  message: Api.TypeMessageIDLike | undefined,
  unpin: boolean,
  notify = false,
  pmOneSide = false,
) {
  message = getMessageId(message) || 0;

  if (message === 0) {
    return await client.invoke(
      new Api.messages.UnpinAllMessages({
        peer: entity,
      }),
    );
  }

  entity = await client.getInputEntity(entity);

  const request = new Api.messages.UpdatePinnedMessage({
    silent: !notify,
    unpin,
    pmOneside: pmOneSide,
    peer: entity,
    id: message,
  });
  const result = await client.invoke(request);

  /**
   * Unpinning does not produce a service message.
   * Pinning a message that was already pinned also produces no service message.
   * Pinning a message in your own chat does not produce a service message,
   * but pinning on a private conversation with someone else does.
   */
  if (
    unpin || !("updates" in result) || ("updates" in result && !result.updates)
  ) {
    return;
  }

  // Pinning a message that doesn't exist would RPC-error earlier
  return client._getResponseMessage(request, result, entity) as Api.Message;
}

export async function markAsRead(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  message?: Api.TypeMessageIDLike | Api.TypeMessageIDLike[],
  markAsReadParams?: MarkAsReadParams,
): Promise<boolean> {
  let maxId: number = markAsReadParams?.maxId || 0;
  const maxIdIsUndefined = markAsReadParams?.maxId === undefined;
  if (maxIdIsUndefined) {
    if (message) {
      if (Array.isArray(message)) {
        maxId = Math.max(
          ...message.map((v) => getMessageId(v) as number),
        );
      } else {
        maxId = getMessageId(message) as number;
      }
    }
  }

  entity = await client.getInputEntity(entity);
  if (markAsReadParams && !markAsReadParams.clearMentions) {
    await client.invoke(new Api.messages.ReadMentions({ peer: entity }));
    if (maxIdIsUndefined && message === undefined) {
      return true;
    }
  }

  if (entityType_(entity) === EntityType_.CHANNEL) {
    return await client.invoke(
      new Api.channels.ReadHistory({ channel: entity, maxId }),
    );
  } else {
    await client.invoke(
      new Api.messages.ReadHistory({ peer: entity, maxId }),
    );
    return true;
  }
}

export async function getCommentData(
  client: AbstractTelegramClient,
  entity: Api.TypeEntityLike,
  message: number | Api.Message,
) {
  const result = await client.invoke(
    new Api.messages.GetDiscussionMessage({
      peer: entity,
      msgId: getMessageId(message),
    }),
  );
  const relevantMessage = result.messages[0];
  let chat;
  for (const c of result.chats) {
    if (
      relevantMessage.peerId instanceof Api.PeerChannel &&
      c.id.eq(relevantMessage.peerId.channelId)
    ) {
      chat = c;
      break;
    }
  }
  return {
    entity: getInputPeer(chat),
    replyTo: relevantMessage.id,
  };
}
