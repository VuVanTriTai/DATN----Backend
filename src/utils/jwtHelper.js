const jwt = require("jsonwebtoken");

const generateToken = (payload, secret, expiry) => {
    // payload nên chứa: { id: user._id, role: user.role }
    return jwt.sign(payload, secret, { expiresIn: expiry });
};

module.exports = { generateToken };
