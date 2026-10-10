/** Pure RFC 8010 wire encoding. Value tags are always walked as TLVs, including collections. */
import { Buffer, constants as bufferConstants } from "node:buffer";

export interface IppValue { tag: number; bytes: Uint8Array }
export interface IppAttribute { name: string; values: IppValue[] }
export interface IppGroup { tag: number; attributes: IppAttribute[] }
export interface IppMessage {
  version: [number, number];
  /** Operation-id in a request; status-code in a response. */
  code: number;
  requestId: number;
  groups: IppGroup[];
  data?: Uint8Array;
}

export const IPP_INT_MAX = 0x7fffffff;
export const IPP_MAX_ATTRIBUTES = 10_000;
export const IPP_TAG = {
  OPERATION_ATTRIBUTES: 0x01, JOB_ATTRIBUTES: 0x02, END_OF_ATTRIBUTES: 0x03,
  PRINTER_ATTRIBUTES: 0x04, UNSUPPORTED_ATTRIBUTES: 0x05,
} as const;
export const IPP_VALUE = {
  INTEGER: 0x21, BOOLEAN: 0x22, ENUM: 0x23, RESOLUTION: 0x32, RANGE: 0x33,
  BEGIN_COLLECTION: 0x34, TEXT_WITH_LANGUAGE: 0x35, NAME_WITH_LANGUAGE: 0x36,
  END_COLLECTION: 0x37, TEXT: 0x41, NAME: 0x42, KEYWORD: 0x44, URI: 0x45,
  CHARSET: 0x47, NATURAL_LANGUAGE: 0x48, MIME_MEDIA_TYPE: 0x49,
  MEMBER_ATTRIBUTE_NAME: 0x4a, EXTENSION: 0x7f,
} as const;
export const IPP_OPERATION = {
  PRINT_JOB: 0x0002, CANCEL_JOB: 0x0008, GET_JOB_ATTRIBUTES: 0x0009,
  GET_PRINTER_ATTRIBUTES: 0x000b, PAUSE_PRINTER: 0x0010, RESUME_PRINTER: 0x0011,
} as const;
export const IPP_STATUS = { SUCCESS_MAX: 0x00ff, SERVER_ERROR_BUSY: 0x0507 } as const;

export class IppEncodeError extends Error {
  constructor(message: string) { super(message); this.name = "IppEncodeError"; }
}
export class IppDecodeError extends Error {
  constructor(message: string) { super(message); this.name = "IppDecodeError"; }
}
export type IppReadResult<T> = { value: T } | { problem: string };

function whole(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new IppEncodeError(message);
}

/** Validate the complete message before allocating or writing its output. */
export function encodeIppMessage(message: IppMessage): Uint8Array {
  check(message !== null && typeof message === "object", "expected an IPP message");
  check(Array.isArray(message.version) && message.version.length === 2
    && message.version.every((n) => whole(n, 0, 255)), "invalid IPP version");
  check(whole(message.code, 0, 65535), "invalid operation or status code");
  check(whole(message.requestId, 1, IPP_INT_MAX), "request-id must be in 1..2147483647");
  check(Array.isArray(message.groups), "invalid attribute groups");
  check(message.data === undefined || message.data instanceof Uint8Array, "document data must be bytes");
  const groups: Array<{ tag: number; attributes: Array<{ name: Buffer; values: IppValue[] }> }> = [];
  let size = 9 + (message.data?.byteLength ?? 0);
  for (const group of message.groups) {
    check(group !== null && typeof group === "object"
      && whole(group.tag, 0, 15) && group.tag !== IPP_TAG.END_OF_ATTRIBUTES, "invalid group delimiter tag");
    check(Array.isArray(group.attributes), "invalid attributes");
    const attributes: Array<{ name: Buffer; values: IppValue[] }> = [];
    size += 1;
    for (const attribute of group.attributes) {
      check(attribute !== null && typeof attribute === "object", "invalid attribute");
      check(typeof attribute.name === "string" && attribute.name.length > 0
        && /^[\x00-\x7f]+$/.test(attribute.name), "attribute name must be nonempty ASCII");
      const name = Buffer.from(attribute.name, "ascii");
      check(name.byteLength <= 32767, "name-length exceeds SIGNED-SHORT");
      check(Array.isArray(attribute.values) && attribute.values.length > 0, "attribute must have at least one value");
      for (let i = 0; i < attribute.values.length; i += 1) {
        const value = attribute.values[i];
        check(value !== null && typeof value === "object" && whole(value.tag, 0x10, 0xff), "invalid value tag");
        check(value.bytes instanceof Uint8Array, "attribute value must be bytes");
        check(value.bytes.byteLength <= 32767, "value-length exceeds SIGNED-SHORT");
        size += 5 + (i === 0 ? name.byteLength : 0) + value.bytes.byteLength;
      }
      attributes.push({ name, values: attribute.values });
    }
    groups.push({ tag: group.tag, attributes });
  }
  check(Number.isSafeInteger(size) && size <= bufferConstants.MAX_LENGTH, "encoded message is too large");
  const output = Buffer.alloc(size);
  output[0] = message.version[0]; output[1] = message.version[1];
  output.writeUInt16BE(message.code, 2); output.writeInt32BE(message.requestId, 4);
  let pos = 8;
  for (const group of groups) {
    output[pos++] = group.tag;
    for (const attribute of group.attributes) {
      for (let i = 0; i < attribute.values.length; i += 1) {
        const value = attribute.values[i];
        output[pos++] = value.tag;
        const nameLength = i === 0 ? attribute.name.byteLength : 0;
        output.writeInt16BE(nameLength, pos); pos += 2;
        if (nameLength) { output.set(attribute.name, pos); pos += nameLength; }
        output.writeInt16BE(value.bytes.byteLength, pos); pos += 2;
        output.set(value.bytes, pos); pos += value.bytes.byteLength;
      }
    }
  }
  output[pos++] = IPP_TAG.END_OF_ATTRIBUTES;
  if (message.data) output.set(message.data, pos);
  return output;
}

export function decodeIppMessage(bytes: Uint8Array): IppMessage {
  if (!(bytes instanceof Uint8Array)) throw new IppDecodeError("expected bytes");
  if (bytes.byteLength < 8) throw new IppDecodeError("truncated header");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups: IppGroup[] = [];
  let pos = 8;
  let attributeCount = 0;
  function length(what: string): number {
    if (pos + 2 > input.byteLength) throw new IppDecodeError(`truncated in ${what}`);
    const count = input.readInt16BE(pos); pos += 2;
    if (count < 0) throw new IppDecodeError(`negative ${what}`);
    return count;
  }
  for (;;) {
    if (pos >= input.byteLength) throw new IppDecodeError("no end-of-attributes-tag");
    const tag = input[pos++];
    if (tag === IPP_TAG.END_OF_ATTRIBUTES) break;
    if (tag <= 0x0f) { groups.push({ tag, attributes: [] }); continue; }
    const group = groups[groups.length - 1];
    if (!group) throw new IppDecodeError("attribute before any attribute group");
    const nameLength = length("name-length");
    if (pos + nameLength > input.byteLength) throw new IppDecodeError("truncated in name");
    // Match pcc-node's ASCII decoder: non-ASCII octets become U+FFFD, never low-bit aliases.
    let name = "";
    for (let i = 0; i < nameLength; i += 1) name += input[pos + i] < 128 ? String.fromCharCode(input[pos + i]) : "\ufffd";
    pos += nameLength;
    const valueLength = length("value-length");
    if (pos + valueLength > input.byteLength) throw new IppDecodeError("truncated in value");
    const value = { tag, bytes: Uint8Array.from(input.subarray(pos, pos + valueLength)) };
    pos += valueLength;
    if (nameLength === 0) {
      const previous = group.attributes[group.attributes.length - 1];
      if (!previous) throw new IppDecodeError("additional-value with no attribute before it");
      previous.values.push(value);
    } else {
      attributeCount += 1;
      if (attributeCount > IPP_MAX_ATTRIBUTES) throw new IppDecodeError("attribute count exceeds limit");
      group.attributes.push({ name, values: [value] });
    }
  }
  return {
    version: [input[0], input[1]], code: input.readUInt16BE(2), requestId: input.readInt32BE(4),
    groups, data: Uint8Array.from(input.subarray(pos)),
  };
}

function numberValue(tag: number, value: number): IppValue {
  check(whole(value, -0x80000000, IPP_INT_MAX), "integer value is outside SIGNED-INTEGER");
  const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return { tag, bytes };
}
export function integerValue(value: number): IppValue { return numberValue(IPP_VALUE.INTEGER, value); }
export function enumValue(value: number): IppValue { return numberValue(IPP_VALUE.ENUM, value); }
export function booleanValue(value: boolean): IppValue {
  check(typeof value === "boolean", "boolean value must be true or false");
  return { tag: IPP_VALUE.BOOLEAN, bytes: Uint8Array.of(value ? 1 : 0) };
}
function stringValue(tag: number, value: string, ascii: boolean): IppValue {
  check(typeof value === "string", "string value must be text");
  check(!ascii || /^[\x00-\x7f]*$/.test(value), "string value must be ASCII");
  const bytes = Buffer.from(value, "utf8");
  check(bytes.toString("utf8") === value, "string value is not valid Unicode");
  check(bytes.byteLength <= 32767, "value-length exceeds SIGNED-SHORT");
  return { tag, bytes };
}
export function keywordValue(value: string): IppValue {
  check(typeof value === "string" && /^[a-z][a-z0-9._-]{0,254}$/.test(value)
    && !value.endsWith("\n"), "keyword is not an RFC 8011 keyword");
  return stringValue(IPP_VALUE.KEYWORD, value, true);
}
export function nameValue(value: string): IppValue { return stringValue(IPP_VALUE.NAME, value, false); }
export function textValue(value: string): IppValue { return stringValue(IPP_VALUE.TEXT, value, false); }
export function uriValue(value: string): IppValue { return stringValue(IPP_VALUE.URI, value, true); }
export function charsetValue(value: string): IppValue { return stringValue(IPP_VALUE.CHARSET, value, true); }
export function naturalLanguageValue(value: string): IppValue { return stringValue(IPP_VALUE.NATURAL_LANGUAGE, value, true); }
export function mimeMediaTypeValue(value: string): IppValue { return stringValue(IPP_VALUE.MIME_MEDIA_TYPE, value, true); }

function usable(value: IppValue): value is IppValue {
  return value !== null && typeof value === "object" && value.bytes instanceof Uint8Array;
}
function readNumber(value: IppValue, tag: number, label: string): IppReadResult<number> {
  if (!usable(value) || value.tag !== tag || value.bytes.byteLength !== 4) return { problem: `not a 4-octet ${label}` };
  return { value: Buffer.from(value.bytes.buffer, value.bytes.byteOffset, 4).readInt32BE() };
}
export function readInteger(value: IppValue): IppReadResult<number> { return readNumber(value, IPP_VALUE.INTEGER, "integer"); }
export function readEnum(value: IppValue): IppReadResult<number> { return readNumber(value, IPP_VALUE.ENUM, "enum"); }
export function readBoolean(value: IppValue): IppReadResult<boolean> {
  if (!usable(value) || value.tag !== IPP_VALUE.BOOLEAN || value.bytes.byteLength !== 1
    || value.bytes[0] > 1) return { problem: "not a 1-octet boolean (0 or 1)" };
  return { value: value.bytes[0] === 1 };
}
export function readKeyword(value: IppValue): IppReadResult<string> {
  if (!usable(value) || value.tag !== IPP_VALUE.KEYWORD) return { problem: "value is not a keyword" };
  if (value.bytes.some((byte) => byte > 0x7f)) return { problem: "keyword is not ASCII" };
  const text = Buffer.from(value.bytes).toString("ascii");
  return /^[a-z][a-z0-9._-]{0,254}$/.test(text) && !text.endsWith("\n")
    ? { value: text } : { problem: "value is not an RFC 8011 keyword" };
}
export function readText(value: IppValue): IppReadResult<string> {
  if (!usable(value)) return { problem: "invalid text value" };
  let bytes = value.bytes;
  if (value.tag === IPP_VALUE.TEXT_WITH_LANGUAGE || value.tag === IPP_VALUE.NAME_WITH_LANGUAGE) {
    if (bytes.byteLength < 4) return { problem: "truncated language-qualified text" };
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const languageLength = input.readInt16BE(0);
    if (languageLength < 1 || languageLength > 63 || languageLength + 4 > bytes.byteLength) return { problem: "invalid language length" };
    const language = input.subarray(2, 2 + languageLength);
    if (language.some((byte) => byte > 0x7f)
      || !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language.toString("ascii"))) return { problem: "invalid text language" };
    const textLength = input.readInt16BE(2 + languageLength);
    if (textLength < 0 || textLength + languageLength + 4 !== bytes.byteLength) return { problem: "invalid language-qualified text length" };
    bytes = bytes.subarray(languageLength + 4);
  } else if (value.tag !== IPP_VALUE.TEXT && value.tag !== IPP_VALUE.NAME) {
    return { problem: "value is not text or name" };
  }
  try { return { value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return { problem: "text is not valid UTF-8" }; }
}
export function readRange(value: IppValue): IppReadResult<{ lower: number; upper: number }> {
  if (!usable(value) || value.tag !== IPP_VALUE.RANGE || value.bytes.byteLength !== 8) return { problem: "not an 8-octet range" };
  const bytes = Buffer.from(value.bytes.buffer, value.bytes.byteOffset, 8);
  return { value: { lower: bytes.readInt32BE(0), upper: bytes.readInt32BE(4) } };
}
export function readResolution(value: IppValue): IppReadResult<{ x: number; y: number; units: number }> {
  if (!usable(value) || value.tag !== IPP_VALUE.RESOLUTION || value.bytes.byteLength !== 9) return { problem: "not a 9-octet resolution" };
  const bytes = Buffer.from(value.bytes.buffer, value.bytes.byteOffset, 9);
  return { value: { x: bytes.readInt32BE(0), y: bytes.readInt32BE(4), units: bytes[8] } };
}
export function singleAttribute(group: IppGroup, name: string): IppReadResult<IppAttribute> {
  if (!group || !Array.isArray(group.attributes)) return { problem: "invalid attribute group" };
  const found = group.attributes.filter((attribute) => attribute?.name === name);
  return found.length === 1 ? { value: found[0] } : { problem: `${found.length} ${name} attributes (expected 1)` };
}
export function jobGroup(message: IppMessage): IppReadResult<IppGroup> {
  if (!message || !Array.isArray(message.groups)) return { problem: "invalid IPP message" };
  const found = message.groups.filter((group) => group?.tag === IPP_TAG.JOB_ATTRIBUTES);
  return found.length === 1 ? { value: found[0] } : { problem: `${found.length} job attribute groups (expected 1)` };
}
