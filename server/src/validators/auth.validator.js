const { body, validationResult } = require("express-validator");
const { AppError } = require("../middleware/errorHandler");
const phoneOtpService = require("../services/phoneOtp.service");
const env = require("../config/env");

/**
 * Final step in every validator chain: convert errors to AppError(400).
 */
const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return next(new AppError("Validation failed", 400, errors.array()));
};

// Roles a client is allowed to self-register as. Admins are bootstrapped only.
const SELF_REGISTER_ROLES = ["owner", "renter", "delivery"];

const registerValidator = [
  body("email")
    .isEmail()
    .withMessage("Invalid email")
    .normalizeEmail(),
  body("password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be 8-128 characters"),
  body("name")
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be 2-100 characters"),
  body("role")
    .isIn(SELF_REGISTER_ROLES)
    .withMessage(`Role must be one of: ${SELF_REGISTER_ROLES.join(", ")}`),
  body("phone")
    .optional({ values: "falsy" })
    .isString()
    // Permissive international phone format. Country-specific check belongs to app logic.
    .matches(/^\+?[0-9\s\-()]{7,20}$/)
    .withMessage("Invalid phone number"),
  body("identity")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ min: 5, max: 64 })
    .withMessage("Identity must be 5-64 characters"),
  body("location")
    .optional({ values: "falsy" })
    .isObject()
    .withMessage("Location must be an object"),
  body("governorate")
    .optional({ values: "falsy" })
    .isIn([
      "muscat", "dhofar", "musandam", "buraimi",
      "dakhiliyah", "north_batinah", "south_batinah",
      "south_sharqiyah", "north_sharqiyah", "dhahirah", "wusta",
    ])
    .withMessage("Invalid governorate"),
  body("referral_code")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ min: 4, max: 16 }),
  validate,
];

// Same fields as registerValidator, but phone is required — the deferred
// registration flow verifies it before any account exists.
const registerInitValidator = [
  body("email").isEmail().withMessage("Invalid email").normalizeEmail(),
  body("password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be 8-128 characters"),
  body("name")
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be 2-100 characters"),
  body("role")
    .isIn(SELF_REGISTER_ROLES)
    .withMessage(`Role must be one of: ${SELF_REGISTER_ROLES.join(", ")}`),
  body("phone")
    .isString()
    .matches(/^\+?[0-9\s\-()]{7,20}$/)
    .withMessage("Invalid phone number"),
  body("identity")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ min: 5, max: 64 })
    .withMessage("Identity must be 5-64 characters"),
  body("location")
    .optional({ values: "falsy" })
    .isObject()
    .withMessage("Location must be an object"),
  body("governorate")
    .optional({ values: "falsy" })
    .isIn([
      "muscat", "dhofar", "musandam", "buraimi",
      "dakhiliyah", "north_batinah", "south_batinah",
      "south_sharqiyah", "north_sharqiyah", "dhahirah", "wusta",
    ])
    .withMessage("Invalid governorate"),
  body("referral_code")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ min: 4, max: 16 }),
  validate,
];

const registerResendValidator = [
  body("pending_registration_id").isUUID().withMessage("Invalid pending_registration_id"),
  validate,
];

const registerVerifyValidator = [
  body("pending_registration_id").isUUID().withMessage("Invalid pending_registration_id"),
  body("code")
    .isString()
    .matches(phoneOtpService.CODE_REGEX)
    .withMessage(`الرمز يجب أن يكون ${env.PHONE_OTP_LENGTH} أرقام`),
  validate,
];

const loginValidator = [
  body("email").isEmail().withMessage("Invalid email").normalizeEmail(),
  body("password").isString().notEmpty().withMessage("Password required"),
  validate,
];

const checkEmailValidator = [
  body("email").isEmail().withMessage("Invalid email").normalizeEmail(),
  validate,
];

// ─── OTP / password reset / password change validators ──────────────────

// 6-digit numeric OTP (we accept it as a string so leading zeros aren't lost).
const OTP_REGEX = /^\d{6}$/;

const verifyEmailValidator = [
  body("code")
    .isString()
    .matches(OTP_REGEX)
    .withMessage("الرمز يجب أن يكون 6 أرقام"),
  validate,
];

const requestPasswordResetValidator = [
  body("email").isEmail().withMessage("Invalid email").normalizeEmail(),
  validate,
];

const resetPasswordValidator = [
  body("email").isEmail().withMessage("Invalid email").normalizeEmail(),
  body("code")
    .isString()
    .matches(OTP_REGEX)
    .withMessage("الرمز يجب أن يكون 6 أرقام"),
  body("new_password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("كلمة المرور يجب أن تكون 8-128 حرفاً"),
  validate,
];

const changePasswordValidator = [
  body("current_password")
    .isString()
    .notEmpty()
    .withMessage("كلمة المرور الحالية مطلوبة"),
  body("new_password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("كلمة المرور يجب أن تكون 8-128 حرفاً"),
  body("code")
    .isString()
    .matches(OTP_REGEX)
    .withMessage("الرمز يجب أن يكون 6 أرقام"),
  // Defensive: don't allow new == current. The DB check would still let
  // you do it, but it's user-hostile.
  body("new_password").custom((val, { req }) => {
    if (val === req.body.current_password) {
      throw new Error("كلمة المرور الجديدة يجب أن تختلف عن الحالية");
    }
    return true;
  }),
  validate,
];

module.exports = {
  validate,
  registerValidator,
  registerInitValidator,
  registerResendValidator,
  registerVerifyValidator,
  loginValidator,
  checkEmailValidator,
  verifyEmailValidator,
  requestPasswordResetValidator,
  resetPasswordValidator,
  changePasswordValidator,
  SELF_REGISTER_ROLES,
};
