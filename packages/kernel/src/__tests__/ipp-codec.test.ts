import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import vectors from "./fixtures/ipp-vectors.json" with { type: "json" };
import {
  IPP_INT_MAX, IPP_MAX_ATTRIBUTES, IPP_OPERATION, IPP_TAG, IPP_VALUE,
  IppDecodeError, IppEncodeError, booleanValue, charsetValue, decodeIppMessage,
  encodeIppMessage, enumValue, integerValue, jobGroup, keywordValue,
  mimeMediaTypeValue, nameValue, naturalLanguageValue, readBoolean, readEnum,
  readInteger, readKeyword, readRange, readResolution, readText, singleAttribute,
  textValue, uriValue,
  type IppAttribute, type IppGroup, type IppMessage, type IppReadResult, type IppValue,
} from "../adapters/ipp-codec.js";

const bytes = (hex: string): Uint8Array => Buffer.from(hex, "hex");
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const attribute = (name: string, ...values: IppValue[]): IppAttribute => ({ name, values });
const base = (): IppMessage => ({ version: [1, 1], code: 0, requestId: 1, groups: [] });
function value<T>(result: IppReadResult<T>): T {
  if ("problem" in result) throw new Error(result.problem);
  return result.value;
}
function named(group: IppGroup, name: string): IppValue {
  return value(singleAttribute(group, name)).values[0];
}
function head(uri: string): IppAttribute[] {
  return [attribute("attributes-charset", charsetValue("utf-8")),
    attribute("attributes-natural-language", naturalLanguageValue("en")),
    attribute("printer-uri", uriValue(uri))];
}

describe("RFC 8010 pure codec", () => {
  it("C1: encodeIppMessage's header, group delimiters, signed lengths and data reproduce Appendix A.1", () => {
    const message: IppMessage = {
      version: [1, 1], code: IPP_OPERATION.PRINT_JOB, requestId: 1,
      groups: [
        { tag: IPP_TAG.OPERATION_ATTRIBUTES, attributes: [
          attribute("attributes-charset", charsetValue("utf-8")),
          attribute("attributes-natural-language", naturalLanguageValue("en-us")),
          attribute("printer-uri", uriValue("ipp://printer.example.com/ipp/print/pinetree")),
          attribute("job-name", nameValue("foobar")),
          attribute("ipp-attribute-fidelity", booleanValue(true)),
        ] },
        { tag: IPP_TAG.JOB_ATTRIBUTES, attributes: [
          attribute("copies", integerValue(20)),
          attribute("sides", keywordValue("two-sided-long-edge")),
        ] },
      ], data: Buffer.from("%!PDF...", "ascii"),
    };
    expect(hex(encodeIppMessage(message))).toBe(vectors.rfc8010["A.1_print_job_request"].hex);
    expect(Buffer.from(decodeIppMessage(encodeIppMessage(message)).data!).toString("ascii")).toBe("%!PDF...");
  });

  it("C2: decodeIppMessage and strict readers reproduce every A.2 expected field", () => {
    const fixture = vectors.rfc8010["A.2_print_job_response_ok"];
    const message = decodeIppMessage(bytes(fixture.hex));
    const group = value(jobGroup(message));
    expect({ version: message.version.join("."), status: message.code, requestId: message.requestId,
      jobId: value(readInteger(named(group, "job-id"))), jobState: value(readEnum(named(group, "job-state"))),
      statusMessage: value(readText(named(message.groups[0], "status-message"))),
    }).toEqual(fixture.expect);
  });

  it("C2: decodeIppMessage walks A.3's zero-length out-of-band sides value", () => {
    const fixture = vectors.rfc8010["A.3_print_job_response_failure"];
    const message = decodeIppMessage(bytes(fixture.hex));
    const group = message.groups.find((entry) => entry.tag === IPP_TAG.UNSUPPORTED_ATTRIBUTES)!;
    expect({ status: message.code, jobId: "problem" in jobGroup(message) ? null : 0,
      unsupported: group.attributes.map((entry) => entry.values[0].tag === 0x10
        ? `${entry.name}(out-of-band 0x10)` : entry.name),
    }).toEqual(fixture.expect);
    expect(named(group, "sides")).toEqual({ tag: 0x10, bytes: new Uint8Array() });
  });

  it("C2: decodeIppMessage reads the separate unsupported and job groups in A.4", () => {
    const fixture = vectors.rfc8010["A.4_print_job_response_ignored_attrs"];
    const message = decodeIppMessage(bytes(fixture.hex));
    const group = value(jobGroup(message));
    expect({ status: message.code, jobId: value(readInteger(named(group, "job-id"))),
      jobState: value(readEnum(named(group, "job-state"))),
    }).toEqual(fixture.expect);
    expect(message.groups.map((entry) => entry.tag)).toEqual([1, 5, 2]);
  });

  it("C3: encodeIppMessage reproduces pcc-node's Print-Job encoder byte for byte", () => {
    const fixture = vectors.pccnode_encoders.print_job;
    const args = fixture.args;
    const attributes = [...head(args.printer_uri),
      attribute("requesting-user-name", nameValue("pcc-node")),
      attribute("job-name", nameValue(args.job_name)),
      attribute("document-format", mimeMediaTypeValue(args.document_format))];
    expect(hex(encodeIppMessage({ version: [2, 0], code: IPP_OPERATION.PRINT_JOB,
      requestId: args.request_id, groups: [{ tag: 1, attributes }], data: Buffer.from(args.document),
    }))).toBe(fixture.hex);
  });

  it("C3: encodeIppMessage uses name-length zero for pcc-node's 1setOf requested attributes", () => {
    const fixture = vectors.pccnode_encoders.get_job_attributes;
    const args = fixture.args;
    const attributes = [...head(args.printer_uri), attribute("job-id", integerValue(args.job_id)),
      attribute("requested-attributes", ...["job-id", "job-state", "job-state-reasons"].map(keywordValue))];
    const encoded = encodeIppMessage({ version: [2, 0], code: IPP_OPERATION.GET_JOB_ATTRIBUTES,
      requestId: args.request_id, groups: [{ tag: 1, attributes }],
    });
    expect(hex(encoded)).toBe(fixture.hex);
    expect(value(singleAttribute(decodeIppMessage(encoded).groups[0], "requested-attributes")).values).toHaveLength(3);
  });

  it("C3: encodeIppMessage reproduces pcc-node's Get-Printer-Attributes encoder byte for byte", () => {
    const fixture = vectors.pccnode_encoders.get_printer_attributes;
    const args = fixture.args;
    expect(hex(encodeIppMessage({ version: [2, 0], code: IPP_OPERATION.GET_PRINTER_ATTRIBUTES,
      requestId: args.request_id, groups: [{ tag: 1, attributes: [...head(args.printer_uri),
        attribute("requesting-user-name", nameValue("pcc-node")),
        attribute("requested-attributes", keywordValue("printer-state"))] }],
    }))).toBe(fixture.hex);
  });

  it("C6: every truncated attribute prefix in every valid golden vector throws only IppDecodeError", () => {
    const fixtures = [
      ...Object.values(vectors.rfc8010), ...Object.values(vectors.pccnode_encoders),
      ...Object.values(vectors.get_job_attributes_answers), ...Object.values(vectors.print_job_answers),
    ];
    let checked = 0;
    for (const fixture of fixtures) {
      if (!fixture || typeof fixture !== "object" || !("hex" in fixture)) continue;
      const input = bytes(fixture.hex);
      let message: IppMessage;
      try { message = decodeIppMessage(input); }
      catch (error) { expect(error).toBeInstanceOf(IppDecodeError); continue; }
      const attributesEnd = input.byteLength - message.data!.byteLength;
      for (let offset = 0; offset < attributesEnd; offset += 1) {
        expect(() => decodeIppMessage(input.subarray(0, offset)), `${offset} of ${fixture.hex}`).toThrow(IppDecodeError);
        checked += 1;
      }
      // RFC 8010 data has no internal framing. Prefixes ending after the end tag are valid
      // messages carrying shorter documents; only HTTP can detect their transport truncation.
      for (let offset = attributesEnd; offset < input.byteLength; offset += 1) {
        expect(decodeIppMessage(input.subarray(0, offset)).data).toHaveLength(offset - attributesEnd);
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("decodeIppMessage walks collections and the 0x7f extension as flat TLVs", () => {
    const message = base();
    message.groups = [{ tag: 2, attributes: [attribute("collection",
      { tag: 0x34, bytes: new Uint8Array() },
      { tag: 0x4a, bytes: Uint8Array.from(Buffer.from("member")) },
      { tag: 0x37, bytes: new Uint8Array() },
      { tag: 0x7f, bytes: Uint8Array.of(0, 0, 0, 1) },
    )] }];
    expect(decodeIppMessage(encodeIppMessage(message)).groups).toEqual(message.groups);
  });

  it.each([
    ["negative name length", "01010000000000010121ffff03"],
    ["negative value length", "01010000000000010121000161ffff03"],
    ["attribute outside group", "010100000000000121000161000003"],
    ["additional value without attribute", "010100000000000101210000000003"],
    ["missing end tag", "010100000000000101"],
  ])("decodeIppMessage refuses %s", (_name, malformed) => {
    expect(() => decodeIppMessage(bytes(malformed))).toThrow(IppDecodeError);
  });

  it("decodeIppMessage caps attribute allocation at 10000", () => {
    const message = base();
    message.groups = [{ tag: 1, attributes: Array.from({ length: IPP_MAX_ATTRIBUTES + 1 },
      () => attribute("a", { tag: 0x10, bytes: new Uint8Array() })) }];
    expect(() => decodeIppMessage(encodeIppMessage(message))).toThrow("attribute count exceeds limit");
  });

  it.each([0, -1, IPP_INT_MAX + 1, 1.5, NaN, Infinity])("encodeIppMessage rejects request-id %s", (requestId) => {
    expect(() => encodeIppMessage({ ...base(), requestId })).toThrow(IppEncodeError);
  });
  it("encodeIppMessage enforces signed-short name and value limits before producing bytes", () => {
    const message = base();
    message.groups = [{ tag: 1, attributes: [attribute("a".repeat(32767), { tag: 0x10, bytes: new Uint8Array(32767) })] }];
    expect(decodeIppMessage(encodeIppMessage(message)).groups[0].attributes[0].name).toHaveLength(32767);
    message.groups[0].attributes[0].name += "a";
    expect(() => encodeIppMessage(message)).toThrow(IppEncodeError);
    message.groups[0].attributes[0].name = "a";
    message.groups[0].attributes[0].values[0].bytes = new Uint8Array(32768);
    expect(() => encodeIppMessage(message)).toThrow(IppEncodeError);
  });
  it("encodeIppMessage rejects invalid header, group, value and data inputs with typed errors", () => {
    const invalid: IppMessage[] = [
      { ...base(), version: [256, 1] }, { ...base(), code: -1 },
      { ...base(), groups: [{ tag: 3, attributes: [] }] },
      { ...base(), groups: [{ tag: 1, attributes: [attribute("", integerValue(1))] }] },
      { ...base(), groups: [{ tag: 1, attributes: [attribute("a", { tag: 1, bytes: new Uint8Array() })] }] },
      { ...base(), groups: [{ tag: 1, attributes: [attribute("a")] }] },
      { ...base(), data: "not bytes" as unknown as Uint8Array },
    ];
    for (const message of invalid) expect(() => encodeIppMessage(message)).toThrow(IppEncodeError);
    expect(() => decodeIppMessage("not bytes" as unknown as Uint8Array)).toThrow(IppDecodeError);
  });
});

describe("strict IPP value readers", () => {
  it("readInteger/readEnum require their own tag and exactly four signed octets", () => {
    expect(readInteger(integerValue(-0x80000000))).toEqual({ value: -0x80000000 });
    expect(readEnum(enumValue(9))).toEqual({ value: 9 });
    expect(readInteger(enumValue(9))).toHaveProperty("problem");
    expect(readEnum(integerValue(9))).toHaveProperty("problem");
    for (const length of [0, 1, 3, 5]) {
      expect(readInteger({ tag: 0x21, bytes: new Uint8Array(length) })).toHaveProperty("problem");
      expect(readEnum({ tag: 0x23, bytes: new Uint8Array(length) })).toHaveProperty("problem");
    }
    expect(() => integerValue(0x80000000)).toThrow(IppEncodeError);
  });
  it("readBoolean requires tag 0x22 and a single 0 or 1", () => {
    expect(readBoolean(booleanValue(false))).toEqual({ value: false });
    expect(readBoolean(booleanValue(true))).toEqual({ value: true });
    for (const invalid of [integerValue(1), { tag: 0x22, bytes: Uint8Array.of(2) },
      { tag: 0x22, bytes: Uint8Array.of(1, 0) }]) expect(readBoolean(invalid)).toHaveProperty("problem");
  });
  it("readKeyword requires lowercase RFC 8011 syntax and refuses one malformed octet", () => {
    expect(readKeyword(keywordValue("job-completed-successfully"))).toEqual({ value: "job-completed-successfully" });
    expect(readKeyword(keywordValue("a".repeat(255)))).toHaveProperty("value");
    for (const invalid of ["", "None", "none\n", "completed ", "a".repeat(256), "1abc", "abc/def", "a\u0080"]) {
      expect(readKeyword({ tag: 0x44, bytes: Buffer.from(invalid) })).toHaveProperty("problem");
      expect(() => keywordValue(invalid)).toThrow(IppEncodeError);
    }
    expect(readKeyword(textValue("none"))).toHaveProperty("problem");
  });
  it("readText accepts UTF-8 name/text and language-qualified name/text", () => {
    expect(readText(textValue("café"))).toEqual({ value: "café" });
    expect(readText(nameValue("作業"))).toEqual({ value: "作業" });
    for (const tag of [0x35, 0x36]) {
      expect(readText({ tag, bytes: bytes("0002656e0005636166c3a9") })).toEqual({ value: "café" });
      expect(readText({ tag, bytes: bytes("0002656e0004636166c3a9") })).toHaveProperty("problem");
      expect(readText({ tag, bytes: bytes("ffff656e0005636166c3a9") })).toHaveProperty("problem");
    }
    expect(readText({ tag: 0x41, bytes: Uint8Array.of(0xff) })).toHaveProperty("problem");
    expect(readText(keywordValue("none"))).toHaveProperty("problem");
  });
  it("readRange/readResolution require exact wire lengths and preserve signed values", () => {
    expect(readRange({ tag: 0x33, bytes: bytes("ffffffff00000064") })).toEqual({ value: { lower: -1, upper: 100 } });
    expect(readResolution({ tag: 0x32, bytes: bytes("0000012c0000025803") })).toEqual({ value: { x: 300, y: 600, units: 3 } });
    for (const invalid of [{ tag: 0x21, bytes: new Uint8Array(8) }, { tag: 0x33, bytes: new Uint8Array(7) }]) {
      expect(readRange(invalid)).toHaveProperty("problem");
    }
    for (const invalid of [{ tag: 0x21, bytes: new Uint8Array(9) }, { tag: 0x32, bytes: new Uint8Array(8) }]) {
      expect(readResolution(invalid)).toHaveProperty("problem");
    }
  });
  it("singleAttribute/jobGroup require exactly one, ignoring matching names in other groups", () => {
    const group: IppGroup = { tag: 2, attributes: [attribute("job-id", integerValue(77))] };
    expect(singleAttribute(group, "job-id")).toEqual({ value: group.attributes[0] });
    expect(singleAttribute(group, "missing")).toHaveProperty("problem");
    expect(singleAttribute({ ...group, attributes: [...group.attributes, ...group.attributes] }, "job-id")).toHaveProperty("problem");
    expect(jobGroup({ ...base(), groups: [{ ...group, tag: 5 }, group] })).toEqual({ value: group });
    expect(jobGroup({ ...base(), groups: [] })).toHaveProperty("problem");
    expect(jobGroup({ ...base(), groups: [group, group] })).toHaveProperty("problem");
  });
  it("every strict reader returns a problem rather than throwing on an unusable value", () => {
    const invalid = undefined as unknown as IppValue;
    for (const reader of [readInteger, readEnum, readBoolean, readKeyword, readText, readRange, readResolution]) {
      expect(reader(invalid)).toHaveProperty("problem");
    }
  });
});
