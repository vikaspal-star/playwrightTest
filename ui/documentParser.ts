// Runs in a bounded child process. Uploaded bytes are data, never executable code.
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; if (input.length > 4500000) process.exit(1); });
process.stdin.on("end", async () => {
  try {
    const { extension, base64 } = JSON.parse(input);
    const data = Buffer.from(base64, "base64");
    let text = ""; let pages: number | undefined;
    if (extension === ".pdf") {
      if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("This is not a valid PDF file.");
      const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
      try {
        const info = await parser.getInfo(); pages = info.total;
        if (pages > 40) throw new Error("Use a document with no more than 40 pages.");
        const result = await parser.getText({ pageJoiner: "\n\n" }); text = result.text;
      } finally { await parser.destroy(); }
    } else if (extension === ".docx") {
      if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("This is not a valid Word document. Use .docx format.");
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } else {
      const encoding = data[0] === 255 && data[1] === 254 ? "utf-16le" : data[0] === 254 && data[1] === 255 ? "utf-16be" : "utf-8";
      text = new TextDecoder(encoding, { fatal: true }).decode(data);
      if (text.includes("\0")) throw new Error("Upload a plain text document, not a binary file.");
    }
    text = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (text.length < 15) throw new Error("No usable text found. Scanned PDFs need OCR before uploading.");
    if (text.length > 60000) throw new Error("The document exceeds 60,000 extracted characters. Split it into smaller documents.");
    process.stdout.write(JSON.stringify({ text, pages }));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 240) : "Document could not be read." })); process.exitCode = 1; }
});
