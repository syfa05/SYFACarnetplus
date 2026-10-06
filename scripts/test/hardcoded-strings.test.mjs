import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../check-hardcoded-strings.mjs';

const n = (p, s) => scanSource(p, s).length;

test('JSX : texte et attributs en dur détectés', () => {
  assert.equal(n('a.tsx', '<p>Bonjour le monde</p>'), 1);
  assert.equal(n('a.tsx', '<input placeholder="Nom du patient" />'), 1);
});
test('JSX : clés i18n et expressions acceptées', () => {
  assert.equal(n('a.tsx', '<p>{t("common.loading")}</p>'), 0);
  assert.equal(n('a.tsx', '<input placeholder={t("patient.name")} />'), 0);
  assert.equal(n('a.tsx', '<p>{count}</p>'), 0);
});
test('Kotlin : Text("…") détecté, getString accepté', () => {
  assert.equal(n('a.kt', 'Text("Scanner la carte")'), 1);
  assert.equal(n('a.kt', 'Text(stringResource(R.string.scan))'), 0);
  assert.equal(n('a.kt', 'Toast.makeText(ctx, "Erreur", 0)'), 1);
});
test('XML Android : littéral détecté, @string accepté, strings.xml exempté', () => {
  assert.equal(n('l.xml', '<TextView android:text="Valider" />'), 1);
  assert.equal(n('l.xml', '<TextView android:text="@string/validate" />'), 0);
  assert.equal(n('res/values/strings.xml', '<string name="a">Valider</string>'), 0);
});
test('i18n-ignore : exception explicite', () => {
  assert.equal(n('a.tsx', '<p>SYFA</p> {/* i18n-ignore */}'), 0);
});
test('autres types de fichiers ignorés', () => {
  assert.equal(n('a.ts', 'const m = "Bonjour";'), 0);
});
