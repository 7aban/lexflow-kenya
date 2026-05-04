const { body } = require('express-validator');

const loginValidation = [
  body('email')
    .exists({ checkFalsy: true })
    .withMessage('Email and password are required'),
  body('password')
    .exists({ checkFalsy: true })
    .withMessage('Email and password are required'),
];

module.exports = { loginValidation };
