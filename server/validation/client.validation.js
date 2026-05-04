const { body } = require('express-validator');

const createClientValidation = [
  body('name')
    .exists({ checkFalsy: true })
    .withMessage('Client name is required'),
];

module.exports = { createClientValidation };
