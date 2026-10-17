// Notifications sent to the plant / yards, suppliers and customers.

import { api, html, fmtDate, seg, qs, table, pageHead, actionBtn } from '../lib.js';

const ENTITY_LINK = {
  customer_order: (id) => `#/orders/${id}`, inventory_order: (id) => `#/purchasing/${id}`, failure: (id) => `#/quality/${id}`,
  tractor: (id) => `#/tractors/${id}`, part: (id) => `#/parts/${id}`,
};
const RECIPIENT_LINK = { supplier: (id) => `#/suppliers/${id}`, customer: (id) => `#/customers/${id}` };

export async function notificationsView() {
  const status = qs().get('status') ?? '';
  const rows = await api(`/notifications${status ? `?status=${status}` : ''}`);
  return html`
    ${pageHead({ title: 'Notifications', sub: 'Messages sent to the plant and yards, suppliers and customers from tasks and records.',
      actions: html`<button class="btn primary" data-dialog="notify">+ New notification</button>` })}
    <section class="card">
      <div class="card-head">${seg('status', [['', 'All'], ['sent', 'Awaiting acknowledgement'], ['acknowledged', 'Acknowledged']], status)}</div>
      ${table([
        { label: 'Sent', key: 'created_date', render: (n) => html`${fmtDate(n.created_date)}<div class="mono small muted">${n.id}</div>` },
        { label: 'To', key: 'recipient_name', render: (n) => html`${RECIPIENT_LINK[n.recipient_type] ? html`<a href="${RECIPIENT_LINK[n.recipient_type](n.recipient_id)}">${n.recipient_name}</a>` : n.recipient_name}
          <div class="small muted">${n.recipient_type === 'site' ? 'Plant / yard' : n.recipient_type}</div>` },
        { label: 'Message', key: 'subject', render: (n) => html`<b>${n.subject}</b>${n.urgency === 'urgent' ? html` <span class="badge critical">Urgent</span>` : ''}<div class="small ink2">${n.body}</div>` },
        { label: 'About', key: 'entity_id', render: (n) => (n.entity_id && ENTITY_LINK[n.entity] ? html`<a class="mono" href="${ENTITY_LINK[n.entity](n.entity_id)}">${n.entity_id}</a>` : '—') },
        { label: 'Status', key: 'status', render: (n) => (n.status === 'acknowledged' ? html`<span class="badge good">Acknowledged ${fmtDate(n.acknowledged_date)}</span>`
          : actionBtn({ label: 'Mark acknowledged', url: `/notifications/${n.id}/ack`, body: {} })) },
      ], rows, { empty: 'No notifications sent yet — use "Notify" on a task, order, PO or failure.' })}
    </section>`;
}

/** Compact list of notifications for a record's detail page. */
export function notificationList(rows) {
  if (!rows?.length) return '';
  return html`<div class="card-head"><h2>Notifications</h2></div>${table([
    { label: 'Sent', key: 'created_date', render: (n) => fmtDate(n.created_date) },
    { label: 'To', key: 'recipient_name' },
    { label: 'Subject', key: 'subject' },
    { label: 'Status', key: 'status', render: (n) => (n.status === 'acknowledged' ? html`<span class="badge good">Acknowledged</span>` : html`<span class="badge plain">Sent</span>`) },
  ], rows)}`;
}
