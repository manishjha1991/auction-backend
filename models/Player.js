const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
    playerID: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["Emerald", "Silver", "Gold", "Sapphire"], required: true },
    role: { type: String, enum: ["Batsman", "Bowler", "Allrounder", "WicketKeeper"], required: true },
    basePrice: { type: Number, required: true },
    style:{ type: String, required: true },
    basePriceUnit: { type: String, enum: ["CR", "Lakh"], required: true },
    overallScore: { type: Number, required: true },
    profilePicture: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    isSold: { type: Boolean, default: false }
});

module.exports = mongoose.model('Player', PlayerSchema);
