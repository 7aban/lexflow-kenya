const { body } = require('express-validator');

const createMatterValidation = [
  body('clientId')
    .exists({ checkFalsy: true })
    .withMessage('Client is required'),
  body('title')
    .exists({ checkFalsy: true })
    .withMessage('Matter title is required'),
];

module.exports = { createMatterValidation };
