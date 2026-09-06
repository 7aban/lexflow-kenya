const { ALLOWED_THEME_KEYS } = require('./themeValidation');

const CLIENT_FIELDS = Object.freeze([
  'name', 'logo', 'primaryColor', 'accentColor', 'websiteURL',
  'email', 'phone', 'address', 'paymentInstructions',
]);
const STAFF_FIELDS = Object.freeze([
  ...CLIENT_FIELDS, 'letterhead', 'kraPin', 'vatNumber', 'invoiceFooterNote',
  'defaultInvoiceDueDays', 'advocateBillingVisibility',
]);
const REMINDER_FIELDS = Object.freeze([
  'remindersEnabled', 'whatsappEnabled', 'emailEnabled', 'twilioSid',
  'twilioFromNumber', 'smtpHost', 'smtpPort', 'smtpUser',
]);
const CREDENTIAL_FIELDS = Object.freeze(['twilioToken', 'smtpPass']);
const MODULE_FIELDS = Object.freeze([
  'retainerManagement', 'kycCdd', 'corporateAuthority', 'retainerLedger',
  'scopeVariation', 'clientTasks', 'advancedCompliance',
]);

// Copy only named scalar presentation/configuration values, never database rows
// or opaque nested objects. New columns are private until explicitly reviewed.
function pickSettings(source = {}, fields = []) {
  return Object.fromEntries(fields.filter(key =>
    Object.prototype.hasOwnProperty.call(source, key)
    && ['string', 'number', 'boolean'].includes(typeof source[key]),
  ).map(key => [key, source[key]]));
}

function serializeTheme(theme = {}, { letterhead = false } = {}) {
  return pickSettings(theme, [...ALLOWED_THEME_KEYS, ...(letterhead ? ['letterhead'] : [])]);
}

function serializeReminderSettings(settings = {}) {
  return {
    ...pickSettings(settings, REMINDER_FIELDS),
    twilioTokenConfigured: Boolean(settings.twilioToken),
    smtpPassConfigured: Boolean(settings.smtpPass),
  };
}

function serializeFirmSettings(settings = {}, role, internalReminders = {}) {
  const staff = ['admin', 'advocate', 'assistant'].includes(role);
  if (!staff && role !== 'client') return {};
  const result = {
    ...pickSettings(settings, staff ? STAFF_FIELDS : CLIENT_FIELDS),
    theme: serializeTheme(settings.theme, { letterhead: staff }),
  };
  if (staff) result.moduleSettings = pickSettings(settings.moduleSettings, MODULE_FIELDS);
  if (role === 'admin') result.reminderSettings = serializeReminderSettings(internalReminders);
  return result;
}

function normalizeReminderSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Reminder settings must be an object.' };
  }
  const value = pickSettings(input, REMINDER_FIELDS);
  for (const key of CREDENTIAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined || input[key] === '') continue;
    if (input[key] === null) value[key] = '';
    else if (typeof input[key] !== 'string' || /^[*\u2022]+$/.test(input[key])) {
      return { error: `${key} must be a replacement string or null to clear.` };
    } else value[key] = input[key];
  }
  return { value };
}

module.exports = {
  CLIENT_FIELDS, STAFF_FIELDS, REMINDER_FIELDS, CREDENTIAL_FIELDS,
  pickSettings, serializeTheme, serializeFirmSettings, normalizeReminderSettingsInput,
};
