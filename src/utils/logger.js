//
// utils/logger.js
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),

    // Ghi file nhưng KHÔNG gây restart nếu ignore đúng
    new winston.transports.File({
      filename: "logs/app.log",
    }),
  ],
});

module.exports = logger;