import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatCode, generateCode, generateToken } from '../../src/cards/codes.js';
import { loadCardsConfig } from '../../src/cards/config.js';
import { buildCardLayout, CARD_HEIGHT, CARD_WIDTH, layoutText, renderCardPdf, type CardLayout, type CardPrintModel } from '../../src/cards/pdf.js';
import { CardService } from '../../src/cards/service.js';
import { cleanup, makeCardEnv, secretsOf } from './helpers.js';

afterEach(cleanup);

const dir = fileURLToPath(new URL('../../../../i18n', import.meta.url));
const fr = JSON.parse(readFileSync(`${dir}/fr.json`, 'utf8'));
const en = JSON.parse(readFileSync(`${dir}/en.json`, 'utf8'));
const model = (kind: CardPrintModel['kind'], over: Partial<CardPrintModel> = {}): CardPrintModel => ({
  kind, surname: 'MBARGA', givenNames: 'Jean Paul', birthDate: '12/03/1988', number: 'CS-2026-0004817', issuedDate: '23/09/2026',
  token: generateToken(), backupCode: generateCode(), issuerName: 'Hôpital de district de Yaoundé', assistanceNumber: '8123', ...over,
});
const fills = (l: CardLayout) => l.pages[0]!.items.flatMap((i) => (i.op === 'rect' ? [i.fill] : []));

describe('gabarits PDF (maquettes du cahier des charges, chapitres 7 et 12)', () => {
  it('format ID-1 (85,6 × 54 mm), recto et verso', () => {
    const l = buildCardLayout(model('adulte'), fr, en);
    expect(l.pages).toHaveLength(2);
    expect(l.width / (72 / 25.4)).toBeCloseTo(85.6, 5);
    expect(l.height / (72 / 25.4)).toBeCloseTo(54, 5);
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([l.width, l.height]);
  });
  it('couleurs : adulte vert, temporaire gris, enfant bleu ; mêmes champs partout', () => {
    expect(fills(buildCardLayout(model('adulte'), fr, en))).toContain('#0f6e52');
    expect(fills(buildCardLayout(model('temporaire'), fr, en))).toContain('#5c6a63');
    expect(fills(buildCardLayout(model('enfant'), fr, en))).toContain('#205c99');
    for (const k of ['adulte', 'temporaire', 'enfant'] as const) {
      const t = layoutText(buildCardLayout(model('adulte', { kind: k, surname: 'NGONO', givenNames: 'Marie Ange', number: 'CE-2026-0012954' }), fr, en)).join('\n');
      for (const needle of ['NGONO', 'Marie Ange', '12/03/1988', 'CE-2026-0012954', 'NOM / SURNAME', 'PRÉNOMS / GIVEN NAMES', 'CODE DE SECOURS / BACKUP CODE', 'Secure Your Follow-up Anywhere']) expect(t, `${k}: ${needle}`).toContain(needle);
    }
  });
  it('contenu imprimé : le QR code porte le seul jeton opaque ; code de secours en XXX-XXX-XXX', () => {
    const m = model('adulte');
    const l = buildCardLayout(m, fr, en);
    const qr = l.pages[0]!.items.filter((i) => i.op === 'qr');
    expect(qr).toHaveLength(1);
    expect(qr[0]).toMatchObject({ op: 'qr', data: m.token });
    expect(layoutText(l)).toContain(formatCode(m.backupCode));
  });
  it('rien d\'autre que ce que prévoit le cahier des charges : ni téléphone, ni niveau d\'identité, ni groupe sanguin, ni représentant', () => {
    for (const k of ['adulte', 'temporaire', 'enfant'] as const) {
      const t = layoutText(buildCardLayout(model(k), fr, en)).join('\n');
      expect(t).not.toMatch(/\b237\d{8}\b|\+237/);
      expect(t).not.toMatch(/niveau|level|sang|blood|groupe|CNI|csu|allerg|diagnos|carnet de|@/i);
    }
  });
  it('carte enfant : « représentant visible après scan », aucune coordonnée ; carte temporaire : mention TEMPORAIRE et validité', () => {
    const child = layoutText(buildCardLayout(model('enfant'), fr, en)).join('\n');
    expect(child).toContain('REPRÉSENTANT(S)');
    expect(child).toContain('Visible par le soignant après scan');
    const temp = layoutText(buildCardLayout(model('temporaire'), fr, en)).join('\n');
    expect(temp).toContain('TEMPORAIRE');
    expect(temp).toContain('Valable jusqu\'à la remise de la carte définitive');
    expect(temp).toContain('Valid until final card is issued');
    expect(layoutText(buildCardLayout(model('adulte'), fr, en)).join('\n')).not.toContain('TEMPORAIRE');
    expect(layoutText(buildCardLayout(model('adulte'), fr, en)).join('\n')).not.toContain('REPRÉSENTANT');
  });
  it('verso : urgence, aucune donnée médicale, perte (numéro d\'assistance), établissement émetteur — bilingue', () => {
    const t = layoutText({ ...buildCardLayout(model('adulte'), fr, en), pages: [buildCardLayout(model('adulte'), fr, en).pages[1]!] }).join('\n');
    for (const needle of ['EN CAS D\'URGENCE', 'aucune donnée médicale', 'no medical data', 'au 8123', 'call 8123', 'Établissement émetteur', 'Issued by', 'Hôpital de district de Yaoundé']) expect(t).toContain(needle);
  });
  it('aucun texte en dur : tout vient des dictionnaires (une clé manquante échoue)', () => {
    const { 'card.back.show': _omit, ...incomplete } = fr;
    expect(() => buildCardLayout(model('adulte'), incomplete, en)).toThrow(/clé i18n absente/);
  });
  it('PDF valide : 2 pages au format ID-1, police embarquée, noms avec lettres africaines (ɛ, ɔ, ŋ)', async () => {
    const pdf = await renderCardPdf(buildCardLayout(model('adulte', { givenNames: 'Ɛlɔ Ŋgᴜ Éloïse' }), fr, en));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = pdf.toString('latin1');
    expect((raw.match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(2);
    expect(raw).toMatch(/\/MediaBox \[\s*0 0 242\.\d+ 153\.\d+\s*\]/);
    expect(raw).toContain('DejaVuSans');
    expect(pdf.length).toBeGreaterThan(5000);
  });
});

describe('impression par l\'API', () => {
  it('l\'agent imprime sa carte émise : PDF, jamais mis en cache, impression journalisée ; secrets absents du JSON', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const issue = await e.call('POST', '/v1/cards', await e.tok(e.agent), { patientId: p, type: 'adulte' });
    const card = issue.json() as Record<string, unknown> & { id: string };
    expect(JSON.stringify(card)).not.toMatch(/token|code|CS1:/i);
    const r = await e.call('GET', `/v1/cards/${card.id}/print`, await e.tok(e.agent));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await e.db.query("SELECT count(*)::int AS n FROM card_event WHERE type='printed'")).rows[0]).toMatchObject({ n: 1 });
  });
  it('ce qui est imprimé : le jeton et le code de la carte, l\'identité du titulaire, l\'établissement émetteur', async () => {
    const e = await makeCardEnv();
    const p = await e.patient({ nom: 'Mbarga', prenoms: 'Jean Paul', dateNaissance: '1988-03-12' });
    const seen: CardLayout[] = [];
    const svc = new CardService(e.db, e.fieldCrypto, e.identity, e.sms, { dict: (l: 'fr' | 'en') => (l === 'fr' ? fr : en), t: () => '' } as never, async () => {},
      loadCardsConfig({ CARDS_ASSISTANCE_NUMBER: '8123' }), () => e.clock.now, undefined,
      { layout: (m, a, b) => { const l = buildCardLayout(m, a, b); seen.push(l); return l; }, render: renderCardPdf });
    const agent = await e.agentRecord();
    const card = await svc.issue(agent, { patientId: p, type: 'adulte' });
    await svc.print(agent, card.id);
    const s = await secretsOf(e, card.id);
    const text = layoutText(seen[0]!);
    expect(text).toContain(s.token);
    expect(text).toContain(formatCode(s.code));
    expect(text).toContain(card.number);
    expect(text).toContain('12/03/1988');
    expect(text.join('\n')).toContain('Hôpital A-1');
    expect(text.join('\n')).toMatch(/NOM \/ SURNAME/);
  });
  it('impression impossible : carte déjà activée, autre établissement, rôle sans droit, numéro d\'assistance non défini', async () => {
    const e = await makeCardEnv();
    const p = await e.patient();
    const card = await e.issue(p);
    const b = await e.establishment('B-1');
    const dirB = await e.staff('op-1', 'dir.b', b, [{ role: 'directeur_medical' }]);
    const sec = await e.staff(e.director, 'sec.a', e.est, [{ role: 'secretaire' }]);
    expect((await e.call('GET', `/v1/cards/${card.id}/print`, await e.tok(dirB))).statusCode).toBe(403);
    expect((await e.call('GET', `/v1/cards/${card.id}/print`, await e.tok(sec))).statusCode).toBe(403);
    expect((await e.call('GET', `/v1/cards/${card.id}/print`, await e.tok('op-1'))).statusCode).toBe(403);
    expect((await e.call('GET', '/v1/cards/pas-un-uuid/print', await e.tok(e.agent))).statusCode).toBe(403);
    const noNumber = new CardService(e.db, e.fieldCrypto, e.identity, e.sms, { dict: () => fr, t: () => '' } as never, async () => {}, loadCardsConfig({}), () => e.clock.now);
    await expect(noNumber.print(await e.agentRecord(), card.id)).rejects.toMatchObject({ code: 'assistance_number_missing' });
    await e.activateCard(card.id);
    expect((await e.call('GET', `/v1/cards/${card.id}/print`, await e.tok(e.agent))).statusCode).toBe(409); // plus d'impression après activation
  });
});
