const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters']
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters']
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user'
    },
    // When the password last changed, to the second. A session token issued
    // before it is refused (authMiddleware), so changing or resetting the
    // password signs out every other session.
    passwordChangedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

// Hash password before saving to database (NEVER store plain text passwords)
userSchema.pre('save', async function () {
  // Only hash if password was modified (not on every save)
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);

  // A changed password ends earlier sessions. Whole seconds, because a
  // token's issue time (iat) is in whole seconds: a token issued in the same
  // second as the change — the one returned with it — stays valid.
  if (!this.isNew) {
    this.passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  }
});

// Method to compare entered password with hashed password in DB
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
