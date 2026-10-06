const mongoose = require('mongoose');

const suggestionSchema = new mongoose.Schema({
  text: String,
  category: String,
  trending: Boolean
});

module.exports = mongoose.model('Suggestion', suggestionSchema);
