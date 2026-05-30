/**
 * Print the E2E report directly to the HP printer via IPP.
 * No daemon needed — sends directly from this machine.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PRINTER_IP = process.env.PRINTER_IP ?? "127.0.0.1";
const REPORT = "C:\\tmp\\pcc-e2e-report.txt";

// Read the report
const report = readFileSync(REPORT, "utf8");
console.log(`Report: ${report.length} chars, ${Buffer.byteLength(report)} bytes`);

// Build a simple IPP Print-Job request
// IPP version 1.1, operation Print-Job (0x0002)
function buildIppPrintJob(content: Buffer): Buffer {
  const parts: Buffer[] = [];

  // IPP header: version 1.1, Print-Job (0x0002), request-id 1
  parts.push(Buffer.from([0x01, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]));

  // Operation attributes tag
  parts.push(Buffer.from([0x01])); // operation-attributes-tag

  // charset
  parts.push(ippAttr(0x47, "attributes-charset", "utf-8"));
  // natural-language
  parts.push(ippAttr(0x48, "attributes-natural-language", "en"));
  // printer-uri
  parts.push(ippAttr(0x45, "printer-uri", `ipp://${PRINTER_IP}/ipp/print`));
  // document-format
  parts.push(ippAttr(0x49, "document-format", "application/octet-stream"));
  // job-name
  parts.push(ippAttr(0x42, "job-name", "PCC Protocol Execution Report"));

  // End of attributes
  parts.push(Buffer.from([0x03]));

  // Document data
  parts.push(content);

  return Buffer.concat(parts);
}

function ippAttr(tag: number, name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name);
  const valBuf = Buffer.from(value);
  const buf = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valBuf.length);
  let off = 0;
  buf[off++] = tag;
  buf.writeUInt16BE(nameBuf.length, off); off += 2;
  nameBuf.copy(buf, off); off += nameBuf.length;
  buf.writeUInt16BE(valBuf.length, off); off += 2;
  valBuf.copy(buf, off);
  return buf;
}

const ippData = buildIppPrintJob(Buffer.from(report));
console.log(`IPP request: ${ippData.length} bytes`);

// Write to temp file and send via curl
const tmpPath = "C:\\tmp\\ipp-request.bin";
writeFileSync(tmpPath, ippData);

try {
  const result = execSync(
    `curl -s -X POST "http://${PRINTER_IP}:631/ipp/print" -H "Content-Type: application/ipp" --data-binary @${tmpPath}`,
    { timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  console.log("IPP response:", result.length, "bytes");
  // Parse the status code from the response
  if (result.length >= 4) {
    const statusCode = result.readUInt16BE(2);
    console.log("IPP status:", statusCode === 0 ? "successful-ok" : `0x${statusCode.toString(16)}`);
  }
  console.log("PRINTED.");
} catch (e: any) {
  console.log("Print failed:", e.message?.slice(0, 200));
}
