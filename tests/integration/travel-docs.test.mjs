/**
 * Tests de agenda física (t15) y documentos reales (t17).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-travel-');
await importLib('lib/store.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

function dateKey(offsetDays = 1) {
  const date = new Date(Date.now() + offsetDays * 24 * 3600_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

test('travel: Cali 16:00 → Palmira 16:30 es inviable con alternativas reales', async () => {
  const date = dateKey(1);
  const response = await api(app.base, 'POST', '/api/travel/plan', {
    fromPlace: 'Cali',
    fromAt: `${date}T16:00:00-05:00`,
    toPlace: 'Palmira',
    toAt: `${date}T16:30:00-05:00`,
    mode: 'auto',
    durationMin: 60
  });
  assert.equal(response.status, 200, response.text.slice(0, 300));
  const plan = response.json;
  assert.equal(plan.feasible, false, JSON.stringify(plan).slice(0, 300));
  assert.ok(Number(plan.km) > 20, `km=${plan.km}`);
  assert.ok(Number(plan.etaMin) > 30, `eta=${plan.etaMin}`);
  assert.ok(Array.isArray(plan.alternatives) && plan.alternatives.length >= 2, `alts=${plan.alternatives?.length}`);
  for (const alternative of plan.alternatives) {
    assert.ok(alternative.at && alternative.kind, JSON.stringify(alternative));
    assert.ok(new Date(alternative.at).getTime() > new Date(`${date}T16:30:00-05:00`).getTime(), 'alternativa anterior al objetivo');
  }
});

test('travel: traslado con holgura es viable', async () => {
  const date = dateKey(2);
  const response = await api(app.base, 'POST', '/api/travel/plan', {
    fromPlace: 'Cali',
    fromAt: `${date}T08:00:00-05:00`,
    toPlace: 'Palmira',
    toAt: `${date}T10:00:00-05:00`,
    mode: 'auto'
  });
  assert.equal(response.status, 200, response.text.slice(0, 300));
  assert.equal(response.json.feasible, true, JSON.stringify(response.json).slice(0, 300));
});

test('travel: lugares (CRUD) y evento con travel + Meet generado', async () => {
  const created = await api(app.base, 'POST', '/api/travel/places', {
    name: 'QA Cliente Norte',
    city: 'Cali',
    address: 'Av. QA 123',
    category: 'cliente',
    lat: 3.5394,
    lng: -76.3036
  });
  assert.ok([200, 201].includes(created.status), created.text.slice(0, 200));
  const placeId = created.json.item?.id || created.json.id;
  assert.ok(placeId, JSON.stringify(created.json).slice(0, 200));

  const list = await api(app.base, 'GET', '/api/travel/places?q=QA%20Cliente');
  assert.equal(list.status, 200);
  assert.ok((list.json.items || []).some((place) => place.id === placeId));

  const tomorrow = dateKey(1);
  // Evento previo con lugar de origen (Oficina Cali) para que el ETA tenga desde dónde calcular.
  const placesResponse = await api(app.base, 'GET', '/api/travel/places?q=Oficina%20Cali');
  const origin = (placesResponse.json.items || []).find((place) => /oficina cali/i.test(place.name)) || (placesResponse.json.items || [])[0];
  assert.ok(origin, 'sin lugar de origen en el catálogo');
  const originEvent = await api(app.base, 'POST', '/api/agenda', {
    title: 'QA origen con lugar',
    start: `${tomorrow}T12:00:00-05:00`,
    end: `${tomorrow}T12:30:00-05:00`,
    location: origin.name,
    placeId: origin.id
  });
  assert.equal(originEvent.status, 201, originEvent.text.slice(0, 300));
  const originEventId = originEvent.json.item.id;

  const event = await api(app.base, 'POST', '/api/agenda', {
    title: 'Visita QA con viaje',
    start: `${tomorrow}T13:00:00-05:00`,
    end: `${tomorrow}T14:00:00-05:00`,
    location: 'QA Cliente Norte',
    placeId,
    travelMode: 'auto'
  });
  assert.equal(event.status, 201, event.text.slice(0, 300));
  const eventId = event.json.item.id;

  const travel = await api(app.base, 'GET', `/api/agenda/${eventId}/travel`);
  assert.equal(travel.status, 200, travel.text.slice(0, 200));
  assert.match(travel.text, /"etaMin"\s*:\s*[1-9]/, travel.text.slice(0, 500));
  assert.match(travel.text, /"resolved"\s*:\s*true/, travel.text.slice(0, 500));

  const meet = await api(app.base, 'POST', `/api/agenda/${eventId}/meet`, {});
  assert.ok([200, 201].includes(meet.status), meet.text.slice(0, 200));
  assert.match(meet.text, /meetLink|hangoutLink|conferenceLink|"url"/i, meet.text.slice(0, 400));

  await api(app.base, 'DELETE', `/api/agenda/${originEventId}/hard`);
  await api(app.base, 'DELETE', `/api/agenda/${eventId}/hard`);
  await api(app.base, 'DELETE', `/api/travel/places/${placeId}`);
});

test('docs: DOCX, XLSX y PPTX reales (ZIP OOXML), listado, descarga y borrado', async () => {
  const specs = [
    { type: 'docx', title: 'Acta QA Word', sections: [{ heading: 'Contexto', paragraphs: ['Párrafo de prueba de la suite.'], bullets: ['Punto uno', 'Punto dos'] }] },
    { type: 'xlsx', title: 'Reporte QA Excel', sheets: [{ name: 'Resumen', columns: [{ header: 'Concepto', type: 'text' }, { header: 'Monto', type: 'currency' }], rows: [['Ingresos', 1000], ['Costos', 400]] }] },
    { type: 'pptx', title: 'Presentación QA', slides: [{ layout: 'cover', title: 'Portada QA', subtitle: 't20' }, { layout: 'content', title: 'Puntos', bullets: ['Uno', 'Dos'] }] }
  ];
  const createdIds = [];
  for (const spec of specs) {
    const created = await api(app.base, 'POST', '/api/docs', spec);
    assert.equal(created.status, 201, `${spec.type}: ${created.text.slice(0, 300)}`);
    const id = created.json.item?.id || created.json.id;
    assert.ok(id, `${spec.type} sin id`);
    createdIds.push(id);

    const download = await fetch(`${app.base}/api/docs/${id}/download`);
    assert.equal(download.status, 200, `${spec.type} download=${download.status}`);
    const buffer = Buffer.from(await download.arrayBuffer());
    assert.ok(buffer.length > 1000, `${spec.type} bytes=${buffer.length}`);
    assert.equal(buffer[0], 0x50, `${spec.type} no es ZIP (P)`);
    assert.equal(buffer[1], 0x4b, `${spec.type} no es ZIP (K)`);
    const body = buffer.toString('utf8');
    assert.ok(body.includes('[Content_Types].xml') || body.includes('word/document.xml') || body.includes('xl/workbook.xml') || body.includes('ppt/presentation.xml'), `${spec.type} sin partes OOXML`);
  }

  const listed = await api(app.base, 'GET', '/api/docs');
  assert.equal(listed.status, 200);
  const ids = (listed.json.items || []).map((item) => item.id);
  for (const id of createdIds) assert.ok(ids.includes(id), `documento ${id} no listado`);

  for (const id of createdIds) {
    const deleted = await api(app.base, 'DELETE', `/api/docs/${id}`);
    assert.equal(deleted.status, 200, deleted.text.slice(0, 200));
    const after = await api(app.base, 'GET', `/api/docs/${id}`);
    assert.equal(after.status, 404, `documento ${id} sigue existiendo`);
  }
});

