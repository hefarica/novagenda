/**
 * Copia de seguridad descargable desde Ajustes.
 */
import { $, toast, confirmDialog, promptDialog } from './core.js';

let initialized = false;

export function initBackup() {
  if (initialized) return;
  initialized = true;
  $('#backupDownload')?.addEventListener('click', downloadBackup);
  $('#backupFullDownload')?.addEventListener('click', downloadFullBackup);
  $('#backupRestore')?.addEventListener('click', () => $('#backupFile')?.click());
  $('#backupFile')?.addEventListener('change', restoreBackup);
}

async function downloadBackup() {
  const button = $('#backupDownload');
  const status = $('#backupStatus');
  if (button) button.disabled = true;
  if (status) { status.className = 'hint'; status.textContent = 'Preparando copia…'; }
  try {
    const response = await fetch('/api/admin/export', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`No se pudo exportar (${response.status}).`);
    const data = await response.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agenda-copilot-${String(data.generatedAt || new Date().toISOString()).slice(0, 10)}.json`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const counts = data.counts || {};
    if (status) {
      status.className = 'hint ok';
      status.textContent = `Copia generada: ${counts.agenda || 0} eventos, ${counts.tasks || 0} tareas, ${counts.documents || 0} documentos.`;
    }
    toast('Copia descargada', 'ok');
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = error.message; }
    toast(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}


async function downloadFullBackup() {
  const button = $('#backupFullDownload');
  const status = $('#backupStatus');
  if (button) button.disabled = true;
  if (status) { status.className = 'hint'; status.textContent = 'Preparando copia completa…'; }
  try {
    const response = await fetch('/api/backup?secrets=none', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`No se pudo generar la copia (${response.status}).`);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const name = match ? match[1] : 'agenda-backup.json';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (status) { status.className = 'hint ok'; status.textContent = 'Copia completa descargada: incluye ajustes y autenticación local; no incluye secretos ni tokens.'; }
    toast('Copia completa descargada', 'ok');
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = error.message; }
    toast(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

async function restoreBackup(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  const button = $('#backupRestore');
  const status = $('#backupRestoreStatus');
  input.value = '';
  if (button) button.disabled = true;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('El archivo supera 16 MB.');
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('El archivo no es JSON válido.'); }
    const data = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;
    if (!data || !Array.isArray(data.agenda) || !data.settings) {
      throw new Error('No parece una copia completa de Agenda Copilot (faltan agenda/settings).');
    }
    const counts = {
      agenda: data.agenda.length,
      tareas: Array.isArray(data.tasks) ? data.tasks.length : 0,
      rutinas: Array.isArray(data.recurrences) ? data.recurrences.length : 0
    };
    if (status) { status.className = 'hint'; status.textContent = `Copia leída: ${counts.agenda} eventos, ${counts.tareas} tareas, ${counts.rutinas} rutinas. Verifica antes de restaurar.`; }
    const ok = await confirmDialog({
      title: 'Restaurar copia completa',
      text: `Se reemplazarán todos los datos actuales por los de esta copia (${counts.agenda} eventos, ${counts.tareas} tareas, ${counts.rutinas} rutinas). También se restauran ajustes y autenticación local; los secretos y tokens no vienen en la copia y se conservan los de esta instalación. No se puede deshacer.`,
      okLabel: 'Continuar',
      danger: true
    });
    if (!ok) {
      if (status) { status.className = 'hint'; status.textContent = 'Restauración cancelada.'; }
      return;
    }
    const code = await promptDialog({
      title: 'Confirmar restauración',
      text: 'Escribe RESTAURAR en mayúsculas para reemplazar los datos actuales.',
      label: 'Confirmación',
      value: ''
    });
    if (code === null) return;
    if (String(code || '').trim().toUpperCase() !== 'RESTAURAR') {
      toast('Confirmación incorrecta; no se restauró nada', 'err');
      return;
    }
    const response = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESTORE', data })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `No se pudo restaurar (${response.status}).`);
    if (status) { status.className = 'hint ok'; status.textContent = `Copia restaurada a las ${new Date().toLocaleTimeString('es-CO')}. Recargando…`; }
    toast('Copia restaurada; recargando', 'ok');
    setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = error.message; }
    toast(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

