const { body } = require("express-validator");
const { validate } = require("./auth.validator");
const phoneOtpService = require("../services/phoneOtp.service");
const env = require("../config/env");

// Same permissive international format used by auth.validator's phone field.
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

const verifyOtpValidator = [
  body("code")
    .isString()
    .matches(phoneOtpService.CODE_REGEX)
    .withMessage(`الرمز يجب أن يكون ${env.PHONE_OTP_LENGTH} أرقام`),
  validate,
];

const requestPhoneChangeValidator = [
  body("new_phone")
    .isString()
    .matches(PHONE_REGEX)
    .withMessage("Invalid phone number"),
  body("current_password").isString().notEmpty().withMessage("كلمة المرور الحالية مطلوبة"),
  validate,
];

const changePhoneValidator = [
  body("new_phone")
    .isString()
    .matches(PHONE_REGEX)
    .withMessage("Invalid phone number"),
  body("current_password").isString().notEmpty().withMessage("كلمة المرور الحالية مطلوبة"),
  body("code")
    .isString()
    .matches(phoneOtpService.CODE_REGEX)
    .withMessage(`الرمز يجب أن يكون ${env.PHONE_OTP_LENGTH} أرقام`),
  validate,
];

module.exports = { verifyOtpValidator, requestPhoneChangeValidator, changePhoneValidator };
