const { body } = require('express-validator');

const generateInvoiceValidation = [
  body('matterId')
    .exists({ checkFalsy: true })
    .withMessage('Matter ID is required'),
];

module.exports = { generateInvoiceValidation };
