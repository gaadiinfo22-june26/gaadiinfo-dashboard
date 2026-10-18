// Shared builders for tests. Ticket shapes mirror real Zoho Desk list-API
// records; identifiers and vehicle numbers are made up.

let seq = 0;

function rawTicket(overrides) {
  seq++;
  return Object.assign({
    // Zoho IDs exceed Number.MAX_SAFE_INTEGER, so build them as strings.
    id: '2798150000010' + String(seq).padStart(5, '0'),
    ticketNumber: String(5000 + seq),
    subject: 'Hi GaadiInfo Support',
    status: 'Open',
    statusType: 'Open',
    createdTime: '2026-10-10T06:00:00.000Z',
    modifiedTime: '2026-10-10T06:05:00.000Z',
    closedTime: null,
    priority: null,
    channel: 'GaadiInfo Care',
    channelCode: 'GAADI_INFO_CARE',
    threadCount: '1',
    contactId: '2798150000020' + String(seq).padStart(5, '0'),
    assigneeId: null,
    customerResponseTime: '2026-10-10T06:00:00.000Z',
    dueDate: null,
    isSpam: false,
    webUrl: 'https://desk.zoho.in/support/example/ShowHomePage.do#Cases/dv/' + seq
  }, overrides || {});
}

module.exports = { rawTicket };
