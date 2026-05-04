const nodemailer = require('nodemailer');
const twilio = require('twilio');

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

module.exports = ({ run, get, genId, money, defaultFirmSettings }) => {
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

  async function logReminderAttempt({ templateId, clientId, matterId = '', invoiceId = '', channel, recipient, status, errorMessage = '' }) {
    await run('INSERT INTO reminder_logs (id,templateId,clientId,matterId,invoiceId,channel,recipient,status,sentAt,errorMessage) VALUES (?,?,?,?,?,?,?,?,?,?)', [genId('REMLOG'), templateId || '', clientId || '', matterId || '', invoiceId || '', channel || '', recipient || '', status, new Date().toISOString(), errorMessage || '']);
  }

  async function sendWhatsApp(settings, phone, message) {
    if (settings.twilioSid && settings.twilioToken && settings.twilioFromNumber) {
      const client = twilio(settings.twilioSid, settings.twilioToken);
      return client.messages.create({ from: settings.twilioFromNumber, to: phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`, body: message });
    }
    console.log(`[WhatsApp Stub] To: ${phone} - ${message}`);
    return { sid: `stub-${Date.now()}` };
  }

  async function sendEmail(settings, to, subject, body) {
    if (settings.smtpHost && settings.smtpUser && settings.smtpPass) {
      const transporter = nodemailer.createTransport({
        host: settings.smtpHost,
        port: Number(settings.smtpPort || 587),
        secure: Number(settings.smtpPort || 587) === 465,
        auth: { user: settings.smtpUser, pass: settings.smtpPass },
      });
      return transporter.sendMail({ from: settings.smtpUser, to, subject, text: body });
    }
    console.log(`[Email Stub] To: ${to} - Subject: ${subject} - ${body}`);
    return { messageId: `stub-${Date.now()}` };
  }

  async function sendReminderForChannel({ eventType, channel, client, matter, invoice, appearance, firm, settings }) {
    const template = await get('SELECT * FROM reminder_templates WHERE eventType=? AND channel=?', [eventType, channel]);
    if (!template) return;
    const values = {
      clientName: client?.name || 'Client',
      matterTitle: matter?.title || invoice?.matterTitle || 'your matter',
      courtDate: appearance?.date || '',
      courtTime: appearance?.time || 'TBA',
      invoiceAmount: money(invoice?.amount || 0),
      invoiceDueDate: invoice?.dueDate || '',
      firmName: firm.name || defaultFirmSettings.name,
      firmPhone: firm.phone || defaultFirmSettings.phone,
    };
    const recipient = channel === 'whatsapp' ? client?.phone : client?.email;
    if (!recipient) return logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient: '', status: 'failed', errorMessage: `Missing ${channel === 'whatsapp' ? 'phone' : 'email'}` });
    try {
      if (channel === 'whatsapp') await sendWhatsApp(settings, recipient, renderTemplate(template.body, values));
      else await sendEmail(settings, recipient, renderTemplate(template.subject || 'Reminder from {{firmName}}', values), renderTemplate(template.body, values));
      await logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient, status: 'sent' });
    } catch (err) {
      await logReminderAttempt({ templateId: template.id, clientId: client?.id, matterId: matter?.id, invoiceId: invoice?.id, channel, recipient, status: 'failed', errorMessage: err.message });
    }
  }

  async function sendReminder(eventType, context, getFirmSettings) {
    const firm = await getFirmSettings();
    const settings = firm.reminderSettings || defaultReminderSettings;
    if (!settings.remindersEnabled) return;
    const matter = context.matter || {};
    const client = context.client || {};
    const matterEnabled = matter.remindersEnabled ?? 'firm_default';
    if (matterEnabled === 'off' || matterEnabled === 'false' || matterEnabled === false) return;
    if (eventType.startsWith('court') && ['off', 'false', false].includes(matter.courtRemindersEnabled)) return;
    if (eventType.startsWith('invoice') && ['off', 'false', false].includes(matter.invoiceRemindersEnabled)) return;
    if (client.remindersEnabled === 0 || client.remindersEnabled === false) return;
    const preference = client.preferredChannel || 'firm_default';
    const allowed = preference === 'none' ? [] : preference === 'both' ? ['whatsapp', 'email'] : preference === 'email' || preference === 'whatsapp' ? [preference] : ['firm_default'];
    const shouldSendWhatsApp = settings.whatsappEnabled && (allowed.includes('firm_default') || allowed.includes('whatsapp'));
    const shouldSendEmail = settings.emailEnabled && (allowed.includes('firm_default') || allowed.includes('email'));
    if (shouldSendWhatsApp) await sendReminderForChannel({ ...context, eventType, channel: 'whatsapp', firm, settings });
    if (shouldSendEmail) await sendReminderForChannel({ ...context, eventType, channel: 'email', firm, settings });
  }

  return {
    defaultReminderSettings,
    defaultReminderTemplates,
    templateKey,
    defaultTemplateFor,
    seedReminderTemplates,
    renderTemplate,
    logReminderAttempt,
    sendWhatsApp,
    sendEmail,
    sendReminderForChannel,
    sendReminder,
  };
};
