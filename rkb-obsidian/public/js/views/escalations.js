// Escalation dialogs shared by every page: notify a site / supplier / customer, and
// arrange a pickup-and-repair for a damaged tractor.

import { api, html, DIALOGS, openDialog, toast, addDays, today, fmtDate, fmtMoney } from '../lib.js';

const TYPES = [['site', 'Plant / yard'], ['supplier', 'Supplier'], ['customer', 'Customer']];

DIALOGS.notify = async (data, done) => {
  const cat = await api('/catalog');
  const lists = {
    site: cat.sites.map((s) => [s.id, `${s.name}${s.is_plant ? ' (plant)' : ''}`]),
    supplier: cat.suppliers.map((s) => [s.id, `${s.name} (${s.code})`]),
    customer: cat.customers.map((c) => [c.id, c.name]),
  };
  const type = data.recipientType ?? 'site';
  const options = (t, selected) => lists[t].map(([id, name]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${name.replace(/</g, '&lt;')}</option>`).join('');
  openDialog('Send a notification', String(html`
    <div class="form-grid">
      <label class="field">Send to<select name="recipientType" id="nt-type">${TYPES.map(([v, l]) => html`<option value="${v}" ${v === type ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="field">Recipient<select name="recipientId" id="nt-recipient"></select></label>
      <label class="field">Urgency<select name="urgency">${['urgent', 'normal'].map((u) => html`<option ${u === (data.urgency ?? 'normal') ? 'selected' : ''}>${u}</option>`)}</select></label>
      <label class="field" style="grid-column:1/-1">Subject<input name="subject" required value="${data.subject ?? ''}"></label>
      <label class="field" style="grid-column:1/-1">Message<textarea name="body" required>${data.body ?? ''}</textarea></label>
    </div>
    <input type="hidden" name="entity" value="${data.entity ?? ''}"><input type="hidden" name="entityId" value="${data.entityId ?? ''}">
    <div class="form-actions"><button class="btn primary">Send</button></div>`), async (body) => {
    const out = await api('/notifications', { method: 'POST', body: { ...body, entity: body.entity || null, entityId: body.entityId || null } });
    toast(`Sent ${out.id} to ${out.recipient}`);
    done();
  });
  const typeSel = document.getElementById('nt-type');
  const recSel = document.getElementById('nt-recipient');
  recSel.innerHTML = options(type, data.recipientId);
  typeSel.addEventListener('change', () => { recSel.innerHTML = options(typeSel.value); });
};

DIALOGS.pickup = async (data, done) => {
  const f = data.failureId ? await api(`/failures/${data.failureId}`) : null;
  const rush = data.rush === '1' || data.rush === true;
  openDialog('Arrange pickup & repair', String(html`
    ${f ? html`<div class="callout" style="margin-bottom:12px"><b>${f.serial_number}</b> at ${f.customer_name}: ${f.part_name} — ${f.description}</div>` : ''}
    <p class="ink2" style="margin-top:0">A carrier collects the tractor from the customer's site, the plant replaces the failed part from stock, and the tractor is trucked back.</p>
    <div class="form-grid">
      <label class="field">Pickup date<input type="date" name="pickupDate" min="${today()}" value="${rush ? today() : addDays(today(), 1)}"></label>
      <label class="field">Priority<select name="rush"><option value="">Standard</option><option value="1" ${rush ? 'selected' : ''}>Rush (+15%, 1 day faster each way)</option></select></label>
      <label class="field" style="grid-column:1/-1"><span><input type="checkbox" name="notifyCustomer" checked> Tell the customer the pickup date</span></label>
      <label class="field" style="grid-column:1/-1">Notes<input name="notes" placeholder="Site access, contact on arrival…"></label>
    </div>
    <div class="form-actions"><button class="btn primary">Book pickup</button></div>`), async (body) => {
    const out = await api('/service-jobs', { method: 'POST', body: {
      failureId: data.failureId ?? null, tractorId: data.tractorId ?? null, rush: !!body.rush, pickupDate: body.pickupDate, notes: body.notes || null,
    } });
    if (body.notifyCustomer && f) {
      await api('/notifications', { method: 'POST', body: {
        recipientType: 'customer', recipientId: f.customer_id, urgency: 'normal', entity: 'failure', entityId: f.id,
        subject: `Pickup of ${f.serial_number} on ${fmtDate(out.pickupDate)}`,
        body: `We will collect ${f.serial_number} on ${fmtDate(out.pickupDate)} for repair at our plant and expect to return it by ${fmtDate(out.expectedReturn)}.`,
      } });
    }
    toast(`Booked ${out.id}: pickup ${fmtDate(out.pickupDate)}, back by ${fmtDate(out.expectedReturn)} · haul ${fmtMoney(out.haulCost)}`);
    location.hash = `#/service/${out.id}`;
    done();
  });
};
