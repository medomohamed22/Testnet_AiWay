import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');
const FONT_PATH = require.resolve('@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff');
const MAX_ITEMS = 1000;

const text = (value, max = 10000) => String(value ?? '').replace(/\0/g, '').slice(0, max);
const safeFilename = (value, extension) => {
  const clean = text(value || `aiway-file.${extension}`, 150)
    .replace(/[\r\n]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim();
  const base = clean || `aiway-file.${extension}`;
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
};
const isRtl = value => /[\u0600-\u06ff]/.test(String(value || ''));
const array = value => Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [];

export function documentFilename(kind, spec = {}) {
  const ext = kind === 'docx' ? 'docx' : kind === 'xlsx' ? 'xlsx' : kind === 'pptx' ? 'pptx' : 'pdf';
  return safeFilename(spec.filename, ext);
}

async function makeDocx(spec) {
  const children = [];
  const title = text(spec.title, 300);
  if (title) children.push(new Paragraph({
    children: [new TextRun({ text: title, bold: true, size: 34 })],
    heading: HeadingLevel.TITLE,
    alignment: isRtl(title) ? AlignmentType.RIGHT : AlignmentType.LEFT,
    bidirectional: isRtl(title)
  }));
  for (const section of array(spec.sections)) {
    const heading = text(section?.heading, 500);
    if (heading) children.push(new Paragraph({
      children: [new TextRun({ text: heading, bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_1,
      alignment: isRtl(heading) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      bidirectional: isRtl(heading)
    }));
    for (const paragraph of array(section?.paragraphs)) {
      const value = text(paragraph, 15000);
      if (!value) continue;
      children.push(new Paragraph({
        children: [new TextRun({ text: value, size: 24 })],
        alignment: isRtl(value) ? AlignmentType.RIGHT : AlignmentType.LEFT,
        bidirectional: isRtl(value),
        spacing: { after: 160, line: 360 }
      }));
    }
    for (const bullet of array(section?.bullets)) {
      const value = text(bullet, 5000);
      if (!value) continue;
      children.push(new Paragraph({
        children: [new TextRun({ text: value, size: 24 })],
        bullet: { level: 0 },
        alignment: isRtl(value) ? AlignmentType.RIGHT : AlignmentType.LEFT,
        bidirectional: isRtl(value),
        spacing: { after: 90 }
      }));
    }
  }
  if (!children.length) children.push(new Paragraph(text(spec.content || 'AiWay document')));
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function makeXlsx(spec) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AiWay';
  workbook.created = new Date();
  const sheets = array(spec.sheets);
  for (const [sheetIndex, sheetSpec] of (sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]).entries()) {
    const name = text(sheetSpec?.name || `Sheet${sheetIndex + 1}`, 31).replace(/[\\/?*\[\]:]/g, '-') || `Sheet${sheetIndex + 1}`;
    const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: Boolean(sheetSpec?.rtl) }] });
    const columns = array(sheetSpec?.columns).map((column, index) => ({
      header: text(typeof column === 'object' ? column.header : column, 500),
      key: text(typeof column === 'object' ? column.key : `c${index + 1}`, 100) || `c${index + 1}`,
      width: Math.min(60, Math.max(10, Number(typeof column === 'object' ? column.width : 18) || 18))
    }));
    if (columns.length) sheet.columns = columns;
    for (const row of array(sheetSpec?.rows)) {
      if (Array.isArray(row)) sheet.addRow(row.slice(0, 100).map(cell => typeof cell === 'object' && cell !== null ? JSON.stringify(cell) : cell));
      else if (row && typeof row === 'object') sheet.addRow(row);
      else sheet.addRow([row]);
    }
    if (sheet.rowCount) {
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).alignment = { vertical: 'middle', horizontal: sheetSpec?.rtl ? 'right' : 'left' };
      sheet.autoFilter = columns.length ? { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } } : undefined;
    }
    sheet.eachRow(row => row.eachCell(cell => {
      cell.alignment = { ...cell.alignment, vertical: 'middle', wrapText: true };
    }));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function makePptx(spec) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'AiWay';
  pptx.subject = text(spec.title, 300);
  pptx.title = text(spec.title || 'AiWay presentation', 300);
  pptx.company = 'AiWay';
  pptx.lang = isRtl(JSON.stringify(spec)) ? 'ar-SA' : 'en-US';
  pptx.theme = {
    headFontFace: 'Arial', bodyFontFace: 'Arial', lang: pptx.lang
  };
  const slides = array(spec.slides).slice(0, 50);
  for (const slideSpec of (slides.length ? slides : [{ title: spec.title || 'AiWay', bullets: [] }])) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FAF8FD' };
    const title = text(slideSpec?.title, 500);
    const rtl = isRtl(title + JSON.stringify(slideSpec?.bullets || []));
    slide.addText(title || 'AiWay', { x: 0.55, y: 0.35, w: 12.2, h: 0.7, fontFace: 'Arial', fontSize: 27, bold: true, color: '21162D', align: rtl ? 'right' : 'left', rtlMode: rtl, margin: 0.06, breakLine: false, fit: 'shrink' });
    const bullets = array(slideSpec?.bullets).slice(0, 12).map(item => ({ text: text(item, 1200), options: { bullet: { indent: 18 }, hanging: 4, breakLine: true } }));
    if (bullets.length) slide.addText(bullets, { x: 0.75, y: 1.25, w: 11.8, h: 5.5, fontFace: 'Arial', fontSize: 20, color: '3A3043', valign: 'top', align: rtl ? 'right' : 'left', rtlMode: rtl, margin: 0.08, breakLine: false, fit: 'shrink', paraSpaceAfterPt: 12 });
    if (slideSpec?.notes) slide.addNotes(text(slideSpec.notes, 5000));
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

async function makePdf(spec) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 54, right: 54 }, info: { Title: text(spec.title || 'AiWay PDF', 300), Author: 'AiWay' } });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  doc.registerFont('NotoArabic', FONT_PATH);
  doc.font('NotoArabic');
  const draw = (value, options = {}) => {
    const content = text(value, 20000);
    if (!content) return;
    const rtl = isRtl(content);
    doc.text(content, { align: rtl ? 'right' : 'left', features: rtl ? ['rtla'] : [], lineGap: 5, ...options });
  };
  if (spec.title) { doc.fontSize(22).fillColor('#21162D'); draw(spec.title, { paragraphGap: 14 }); }
  doc.fontSize(12).fillColor('#3A3043');
  for (const section of array(spec.sections)) {
    if (section?.heading) { doc.moveDown(0.5).fontSize(16).fillColor('#6F2DBD'); draw(section.heading, { paragraphGap: 8 }); doc.fontSize(12).fillColor('#3A3043'); }
    for (const paragraph of array(section?.paragraphs)) draw(paragraph, { paragraphGap: 9 });
    for (const bullet of array(section?.bullets)) draw(`• ${text(bullet, 5000)}`, { indent: 12, paragraphGap: 4 });
  }
  if (!array(spec.sections).length) draw(spec.content || 'AiWay PDF');
  doc.end();
  return done;
}

export async function generateDocumentBuffer(kind, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('INVALID_DOCUMENT_JSON');
  if (kind === 'docx') return makeDocx(spec);
  if (kind === 'xlsx') return makeXlsx(spec);
  if (kind === 'pptx') return makePptx(spec);
  if (kind === 'pdf') return makePdf(spec);
  throw new Error('INVALID_DOCUMENT_KIND');
}

export function documentContentType(kind) {
  return {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf'
  }[kind] || 'application/octet-stream';
}
