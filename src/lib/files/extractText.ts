"use client";

export const ACCEPTED_FILE_TYPES =
  ".pdf,.xlsx,.xls,.csv,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,text/markdown";

/** Dispatches to a parser by file extension, and returns plain text ready to chunk. */
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) return extractFromPdf(file);
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return extractFromSpreadsheet(file);
  if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".md")) {
    return file.text();
  }

  throw new Error(
    "Unsupported file type — use PDF, Excel (.xlsx/.xls), CSV, or plain text (.txt/.md)."
  );
}

/**
 * pdfjs-dist touches browser-only globals (DOMMatrix) as soon as its module
 * is evaluated. Next.js still evaluates "use client" components once on the
 * server to produce the initial HTML, which would crash the build if this
 * were a normal top-level import. Loading it dynamically, inside the
 * function, means it's only ever evaluated when actually called - which
 * only happens from a browser event handler (the file input's onChange).
 */
async function extractFromPdf(file: File): Promise<string> {
  const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist");

  GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pageTexts.push(text);
  }

  return pageTexts.join("\n\n");
}

/**
 * Each sheet becomes CSV text under a "Sheet: <name>" heading, then all
 * sheets are concatenated - simple, and chunk.ts's word-based chunker
 * handles it fine, same as any other plain text.
 */
async function extractFromSpreadsheet(file: File): Promise<string> {
  const XLSX = await import("xlsx");

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `Sheet: ${sheetName}\n${csv}`;
  }).join("\n\n");
}
