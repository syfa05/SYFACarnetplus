import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { formatCode } from './codes.js';

export type CardKind = 'adulte' | 'enfant' | 'temporaire';

/** Ce qui est imprimé sur la carte — et RIEN d'autre (pas de niveau d'identité, de groupe sanguin, de téléphone, de représentant). */
export interface CardPrintModel {
  kind: CardKind;
  surname: string;
  givenNames: string;
  /** JJ/MM/AAAA */
  birthDate: string;
  number: string;
  /** JJ/MM/AAAA */
  issuedDate: string;
  token: string;
  /** 9 caractères, sans tirets. */
  backupCode: string;
  issuerName: string;
  assistanceNumber: string;
}

export type Dict = Record<string, string>;
export type Item =
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: string; radius?: number; stroke?: string }
  | { op: 'text'; x: number; y: number; text: string; font: 'sans' | 'bold' | 'mono'; size: number; color: string; width?: number; align?: 'left' | 'center' | 'right'; rotate?: number }
  | { op: 'qr'; x: number; y: number; size: number; data: string };
export interface Page { items: Item[] }
export interface CardLayout { width: number; height: number; pages: Page[] }

/** Format ID-1 : 85,6 × 54 mm (identique à la CNI et aux cartes bancaires), en points (1 pt = 1/72 pouce). */
const MM = 72 / 25.4;
export const CARD_WIDTH = 85.6 * MM;
export const CARD_HEIGHT = 54 * MM;

const COLOR = {
  green: '#0f6e52', gold: '#e1b03c', gray: '#5c6a63', blue: '#205c99', ink: '#1b2a25', muted: '#5b6b65', tint: '#e8f1ed',
  grayTint: '#eceeed', blueTint: '#e6eef8', red: '#b3261e', line: '#b9c6c1',
} as const;

const HEADER: Record<CardKind, { fill: string; tint: string }> = {
  adulte: { fill: COLOR.green, tint: COLOR.tint },
  temporaire: { fill: COLOR.gray, tint: COLOR.grayTint },
  enfant: { fill: COLOR.blue, tint: COLOR.blueTint },
};

/** Texte bilingue « français / anglais ». */
const bi = (fr: Dict, en: Dict, key: string, sep = ' / ', vars: Record<string, string> = {}) =>
  `${sub(fr, key, vars)}${sep}${sub(en, key, vars)}`;
function sub(d: Dict, key: string, vars: Record<string, string> = {}): string {
  const raw = d[key];
  if (raw === undefined) throw new Error(`clé i18n absente : ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * Gabarits officiels (maquettes du cahier des charges, chapitres 7 et 12) : recto et verso, bilingues, aucune chaîne en dur
 * (tous les textes viennent de i18n/fr.json et i18n/en.json). Fonction pure : les tests vérifient CE QUI EST IMPRIMÉ.
 */
export function buildCardLayout(m: CardPrintModel, fr: Dict, en: Dict): CardLayout {
  const W = CARD_WIDTH, H = CARD_HEIGHT;
  const hdr = HEADER[m.kind];
  const code = formatCode(m.backupCode);
  const recto: Item[] = [
    { op: 'rect', x: 0, y: 0, w: W, h: H, fill: '#ffffff', radius: 9, stroke: COLOR.line },
    { op: 'rect', x: 0, y: 0, w: W, h: 38, fill: hdr.fill, radius: 9 },
    { op: 'rect', x: 0, y: 20, w: W, h: 18, fill: hdr.fill },
    { op: 'rect', x: 0, y: 38, w: W, h: 2, fill: COLOR.gold },
    { op: 'text', x: 10, y: 8, text: sub(fr, 'card.brand'), font: 'bold', size: 11, color: '#ffffff' },
    { op: 'text', x: 96, y: 11, text: `· ${bi(fr, en, `card.title.${m.kind}`, ' · ')}`, font: 'sans', size: 6.2, color: '#ffffff', width: W - 100 },
    { op: 'text', x: 10, y: 26, text: bi(en, fr, 'card.tagline', ' · '), font: 'sans', size: 5.8, color: '#ffffff', width: W - 20 },
    // identité
    { op: 'text', x: 10, y: 47, text: bi(fr, en, 'card.label.surname'), font: 'sans', size: 4.8, color: COLOR.muted },
    { op: 'text', x: 10, y: 53, text: m.surname, font: 'bold', size: 10, color: COLOR.ink, width: 112 },
    { op: 'text', x: 10, y: 68, text: bi(fr, en, 'card.label.given_names'), font: 'sans', size: 4.8, color: COLOR.muted },
    { op: 'text', x: 10, y: 74, text: m.givenNames, font: 'bold', size: 8.5, color: COLOR.ink, width: 112 },
    { op: 'text', x: 10, y: 88, text: bi(fr, en, 'card.label.birth'), font: 'sans', size: 4.8, color: COLOR.muted },
    { op: 'text', x: 10, y: 94, text: m.birthDate, font: 'bold', size: 9, color: COLOR.ink },
    { op: 'text', x: 10, y: 108, text: bi(fr, en, 'card.label.number'), font: 'sans', size: 4.8, color: COLOR.muted },
    { op: 'text', x: 10, y: 114, text: m.number, font: 'bold', size: 9, color: COLOR.ink },
  ];
  if (m.kind !== 'temporaire') {
    recto.push(
      { op: 'text', x: 10, y: 129, text: bi(fr, en, 'card.label.issued'), font: 'sans', size: 4.8, color: COLOR.muted },
      { op: 'text', x: 10, y: 135, text: m.issuedDate, font: 'bold', size: 7.5, color: COLOR.ink },
    );
  }
  if (m.kind === 'enfant') {
    // Aucune coordonnée du représentant sur la carte : le soignant les voit dans le dossier après scan.
    recto.push(
      { op: 'text', x: 118, y: 47, text: sub(fr, 'card.label.representatives'), font: 'sans', size: 4.4, color: COLOR.muted, width: 48 },
      { op: 'text', x: 118, y: 53, text: sub(en, 'card.label.representatives'), font: 'sans', size: 4.4, color: COLOR.muted, width: 48 },
      { op: 'text', x: 118, y: 64, text: sub(fr, 'card.representatives_note'), font: 'sans', size: 5.2, color: COLOR.ink, width: 46 },
    );
  }
  if (m.kind === 'temporaire') {
    recto.push(
      { op: 'text', x: 84, y: 98, text: sub(fr, 'card.stamp.temporaire'), font: 'bold', size: 9, color: COLOR.red, rotate: -8 },
      { op: 'text', x: 10, y: 129, text: sub(fr, 'card.valid_until'), font: 'bold', size: 4.4, color: COLOR.red, width: 150 },
      { op: 'text', x: 10, y: 136, text: sub(en, 'card.valid_until'), font: 'bold', size: 4.4, color: COLOR.red, width: 150 },
    );
  }
  recto.push(
    { op: 'qr', x: W - 76, y: 46, size: 66, data: m.token },
    { op: 'text', x: W - 84, y: 114, text: bi(fr, en, 'card.label.backup'), font: 'sans', size: 3.9, color: COLOR.muted, width: 80, align: 'center' },
    { op: 'rect', x: W - 77, y: 123, w: 68, h: 14, fill: hdr.tint, radius: 3 },
    { op: 'text', x: W - 77, y: 126.5, text: code, font: 'mono', size: 8.5, color: COLOR.ink, width: 68, align: 'center' },
  );

  const verso: Item[] = [
    { op: 'rect', x: 0, y: 0, w: W, h: H, fill: '#ffffff', radius: 9, stroke: COLOR.line },
    { op: 'rect', x: 0, y: 14, w: W, h: 3, fill: COLOR.green },
    { op: 'rect', x: 0, y: 17, w: W, h: 1.5, fill: COLOR.gold },
    { op: 'text', x: 14, y: 26, text: sub(fr, 'card.back.emergency'), font: 'bold', size: 8, color: COLOR.ink },
    { op: 'text', x: 14, y: 37, text: sub(fr, 'card.back.show'), font: 'sans', size: 6, color: COLOR.ink, width: W - 28 },
    { op: 'text', x: 14, y: 44, text: `${sub(en, 'card.back.emergency')}: ${sub(en, 'card.back.show')}`, font: 'sans', size: 4.6, color: COLOR.muted, width: W - 28 },
    { op: 'text', x: 14, y: 56, text: sub(fr, 'card.back.nodata'), font: 'sans', size: 5.6, color: COLOR.ink, width: W - 28 },
    { op: 'text', x: 14, y: 80, text: sub(en, 'card.back.nodata'), font: 'sans', size: 4.6, color: COLOR.muted, width: W - 28 },
    { op: 'text', x: 14, y: 96, text: sub(fr, 'card.back.lost', { number: m.assistanceNumber }), font: 'bold', size: 5.4, color: COLOR.ink, width: W - 28 },
    { op: 'text', x: 14, y: 113, text: sub(en, 'card.back.lost', { number: m.assistanceNumber }), font: 'sans', size: 4.6, color: COLOR.muted, width: W - 28 },
    { op: 'rect', x: 12, y: 127, w: W - 24, h: 18, fill: COLOR.tint, radius: 3 },
    { op: 'text', x: 18, y: 132, text: `${bi(fr, en, 'card.back.issuer')} : ${m.issuerName}`, font: 'sans', size: 5.4, color: COLOR.ink, width: W - 36 },
  ];
  return { width: W, height: H, pages: [{ items: recto }, { items: verso }] };
}

/** Texte de toutes les zones imprimées (pour contrôle du contenu). */
export const layoutText = (l: CardLayout): string[] => l.pages.flatMap((p) => p.items.flatMap((i) => (i.op === 'text' ? [i.text] : i.op === 'qr' ? [i.data] : [])));

const require = createRequire(import.meta.url);
let fontDir: string | undefined;
function fonts(): Record<'sans' | 'bold' | 'mono', string> {
  fontDir ??= join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  return { sans: join(fontDir, 'DejaVuSans.ttf'), bold: join(fontDir, 'DejaVuSans-Bold.ttf'), mono: join(fontDir, 'DejaVuSansMono-Bold.ttf') };
}

/**
 * Rend le gabarit en PDF (une page par face, au format ID-1). Police embarquée DejaVu : les noms camerounais peuvent porter des
 * lettres (ɛ, ɔ, ŋ…) absentes des polices standard d'un PDF. QR code dessiné en vectoriel (net à toute taille d'impression).
 */
export async function renderCardPdf(l: CardLayout, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const f = fonts();
  const doc = new PDFDocument({ size: [l.width, l.height], margin: 0, autoFirstPage: false, compress: opts.compress ?? true, info: { Title: 'SYFA Carnet+', Producer: 'SYFA Carnet+' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  for (const page of l.pages) {
    doc.addPage({ size: [l.width, l.height], margin: 0 });
    for (const it of page.items) {
      if (it.op === 'rect') {
        doc.save();
        if (it.radius) doc.roundedRect(it.x, it.y, it.w, it.h, it.radius); else doc.rect(it.x, it.y, it.w, it.h);
        if (it.stroke) doc.fillAndStroke(it.fill, it.stroke); else doc.fill(it.fill);
        doc.restore();
      } else if (it.op === 'text') {
        doc.save();
        if (it.rotate) doc.rotate(it.rotate, { origin: [it.x, it.y] });
        doc.font(f[it.font]).fontSize(it.size).fillColor(it.color).text(it.text, it.x, it.y, { width: it.width, align: it.align ?? 'left', lineBreak: it.width !== undefined });
        doc.restore();
      } else {
        const qr = QRCode.create(it.data, { errorCorrectionLevel: 'M' });
        const n = qr.modules.size;
        const quiet = 2; // marge blanche (modules)
        const cell = it.size / (n + 2 * quiet);
        doc.save();
        doc.rect(it.x, it.y, it.size, it.size).fill('#ffffff');
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(it.x + (c + quiet) * cell, it.y + (r + quiet) * cell, cell + 0.05, cell + 0.05).fill(COLOR.ink);
        doc.restore();
      }
    }
  }
  doc.end();
  return done;
}
