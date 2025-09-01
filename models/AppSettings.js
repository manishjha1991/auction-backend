const mongoose = require('mongoose');

const AppSettingsSchema = new mongoose.Schema(
  {
    enableTradeCenter: { type: Boolean, default: true },
    enableUnsoldPlayers: { type: Boolean, default: true },
    enablePickButton: { type: Boolean, default: true },
    // overall: default single table; groups: split standings by groups
    pointsMode: { type: String, enum: ['overall', 'groups'], default: 'overall' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppSettings', AppSettingsSchema);


