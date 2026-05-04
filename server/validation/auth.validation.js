const { body } = require('express-validator');

const loginValidation = [
  body('email')
    .exists({ checkFalsy: true })
    .withMessage('Email and password are required'),
  body('password')
    .exists({ checkFalsy: true })
    .withMessage('Email and password are required'),
];

const registerValidation = [
  body('email')
    .exists({ checkFalsy: true })
    .withMessage('email, password and fullName are required'),
  body('password')
    .exists({ checkFalsy: true })
    .withMessage('email, password and fullName are required'),
  body('fullName')
    .exists({ checkFalsy: true })
    .withMessage('email, password and fullName are required'),
  body('role')
    .optional()
    .isIn(['advocate', 'assistant', 'admin', 'client'])
    .withMessage('Invalid role'),
  body('clientId')
    .custom((value, { req }) => {
      if (req.body.role === 'client' && !value) return false;
      return true;
    })
    .withMessage('Client users must be linked to a client record'),
];

const invitationValidation = [
  body('email')
    .exists({ checkFalsy: true })
    .withMessage('email is required'),
];

module.exports = { loginValidation, registerValidation, invitationValidation };
