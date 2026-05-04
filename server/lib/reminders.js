const defaultReminderSettings = {
  remindersEnabled: true,
  whatsappEnabled: false,
  emailEnabled: false,
  twilioSid: '',
  twilioToken: '',
  twilioFromNumber: '',
  smtpHost: '',
  smtpPort: '',
  smtpUser: '',
  smtpPass: '',
};

const defaultReminderTemplates = [
  {
    eventType: 'court_date_tomorrow',
    channel: 'whatsapp',
    subject: '',
    body: 'Good evening {{clientName}}. This is a courteous reminder from {{firmName}} that {{matterTitle}} is listed for court tomorrow, {{courtDate}}, at {{courtTime}}. For any urgent clarification, contact us on {{firmPhone}}.',
  },
  {
    eventType: 'court_date_tomorrow',
    channel: 'email',
    subject: 'Court reminder for {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a courteous reminder that {{matterTitle}} is listed for court tomorrow, {{courtDate}}, at {{courtTime}}.\n\nPlease contact {{firmName}} on {{firmPhone}} if you require any clarification.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'court_date_today',
    channel: 'whatsapp',
    subject: '',
    body: 'Good morning {{clientName}}. {{matterTitle}} is listed for court today, {{courtDate}}, at {{courtTime}}. {{firmName}} will keep you updated. For urgent assistance call {{firmPhone}}.',
  },
  {
    eventType: 'court_date_today',
    channel: 'email',
    subject: 'Court appearance today: {{matterTitle}}',
    body: 'Dear {{clientName}},\n\n{{matterTitle}} is listed for court today, {{courtDate}}, at {{courtTime}}.\n\nWe will keep you updated on progress. For urgent assistance, contact us on {{firmPhone}}.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'invoice_overdue',
    channel: 'whatsapp',
    subject: '',
    body: 'Dear {{clientName}}, this is a polite reminder from {{firmName}} that an invoice for {{matterTitle}} of {{invoiceAmount}} due on {{invoiceDueDate}} is overdue. Kindly contact us on {{firmPhone}} if you need assistance.',
  },
  {
    eventType: 'invoice_overdue',
    channel: 'email',
    subject: 'Overdue invoice reminder - {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a polite reminder that an invoice for {{matterTitle}} amounting to {{invoiceAmount}} and due on {{invoiceDueDate}} is overdue.\n\nKindly contact us on {{firmPhone}} if you need assistance or have already made payment.\n\nKind regards,\n{{firmName}}',
  },
  {
    eventType: 'invoice_outstanding',
    channel: 'whatsapp',
    subject: '',
    body: 'Dear {{clientName}}, this is a gentle reminder from {{firmName}} that your invoice for {{matterTitle}} of {{invoiceAmount}} is due on {{invoiceDueDate}}. Thank you.',
  },
  {
    eventType: 'invoice_outstanding',
    channel: 'email',
    subject: 'Upcoming invoice due date - {{matterTitle}}',
    body: 'Dear {{clientName}},\n\nThis is a gentle reminder that your invoice for {{matterTitle}} amounting to {{invoiceAmount}} is due on {{invoiceDueDate}}.\n\nThank you for your attention.\n\nKind regards,\n{{firmName}}',
  },
];

module.exports = ({ run, get, genId }) => {
  function templateKey(template) {
    return `${template.eventType}:${template.channel}`;
  }

  function defaultTemplateFor(eventType, channel) {
    return defaultReminderTemplates.find(t => t.eventType === eventType && t.channel === channel);
  }

  async function seedReminderTemplates() {
    for (const template of defaultReminderTemplates) {
      const existing = await get('SELECT id FROM reminder_templates WHERE eventType=? AND channel=?', [template.eventType, template.channel]);
      if (!existing) {
        await run('INSERT INTO reminder_templates (id,eventType,channel,subject,body,createdBy,createdAt) VALUES (?,?,?,?,?,?,?)', [genId('RT'), template.eventType, template.channel, template.subject || '', template.body, 'system', new Date().toISOString()]);
      }
    }
  }

  function renderTemplate(text = '', values = {}) {
    return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
  }

  return {
    defaultReminderSettings,
    defaultReminderTemplates,
    templateKey,
    defaultTemplateFor,
    seedReminderTemplates,
    renderTemplate,
  };
};
