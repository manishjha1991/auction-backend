/**
 * Fix Player Sale to Highest Bidder
 * 
 * This script fixes a player sale to ensure it's sold to the highest bidder
 * regardless of whether they exited their bid or not.
 * 
 * It fixes:
 * - UserPlayer (ownership)
 * - Player document (currentBidder, currentBid, isSold)
 * - User purses (refund wrong owner, deduct from correct owner)
 * - User.currentBids arrays (remove sold players)
 * - BidHistory (mark correct bid as winner)
 * - Bid documents (deactivate all bids when sold)
 * 
 * Usage: node scripts/fixPlayerSale.js <playerId>
 * Example: node scripts/fixPlayerSale.js 676d7d14ed25f86180707fae
 */

/* eslint-disable no-console */
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const readline = require('readline');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const HARD_CODED_URI =
  'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/?retryWrites=true&w=majority&appName=auction-app';

const uri = process.env.MONGODB_URI || process.env.DB_URI || HARD_CODED_URI;
const dbName = 'cpl_15';

// Load models
const Player = require('../models/Player');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const BidHistory = require('../models/BidHistory');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function fixPlayerSale(playerId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log(`\n🔍 Analyzing player: ${playerId}\n`);

    // 1. Find the player
    const player = await Player.findById(playerId).session(session);
    if (!player) {
      throw new Error(`Player not found: ${playerId}`);
    }

    console.log(`📋 Player: ${player.name} (${player._id})`);
    console.log(`   Current Status: isSold=${player.isSold}, currentBidder=${player.currentBidder || 'N/A'}\n`);

    // 2. Find the HIGHEST bid EVER (regardless of isActive/isBidOn)
    const allBids = await Bid.find({ playerId: playerId })
      .sort({ bidAmount: -1 })
      .session(session);

    if (!allBids || allBids.length === 0) {
      throw new Error('No bids found for this player');
    }

    const highestBid = allBids[0];
    const highestBidder = await User.findById(highestBid.bidder).session(session);
    
    console.log(`🏆 Highest Bid Found:`);
    console.log(`   Bidder: ${highestBidder?.name || highestBidder?.teamName || 'Unknown'} (${highestBid.bidder})`);
    console.log(`   Amount: ₹${highestBid.bidAmount.toLocaleString()}`);
    console.log(`   Status: isActive=${highestBid.isActive}, isBidOn=${highestBid.isBidOn}\n`);

    // 3. Check current UserPlayer (who currently owns it)
    const currentUserPlayer = await UserPlayer.findOne({
      playerId: playerId,
      isActive: true
    }).session(session);

    let currentOwner = null;
    if (currentUserPlayer) {
      currentOwner = await User.findById(currentUserPlayer.userId).session(session);
      console.log(`👤 Current Owner:`);
      console.log(`   User: ${currentOwner?.name || currentOwner?.teamName || 'Unknown'} (${currentUserPlayer.userId})`);
      console.log(`   Bid Value: ₹${currentUserPlayer.bidValue.toLocaleString()}\n`);
    } else {
      console.log(`👤 Current Owner: None (player not sold yet)\n`);
    }

    // 4. Check if fix is needed
    const needsFix = !currentUserPlayer || 
                     currentUserPlayer.userId.toString() !== highestBid.bidder.toString() ||
                     currentUserPlayer.bidValue !== highestBid.bidAmount;

    if (!needsFix && player.isSold) {
      // Even if owner is correct, we still need to deactivate bids if player is sold
      const activeBidsCount = await Bid.countDocuments({
        playerId: playerId,
        isActive: true,
        isBidOn: true
      }).session(session);

      if (activeBidsCount > 0) {
        console.log(`⚠️  Player is sold but has ${activeBidsCount} active bid(s). Deactivating...\n`);
        await Bid.updateMany(
          { playerId: playerId },
          { $set: { isActive: false, isBidOn: false } }
        ).session(session);
        console.log(`✅ Deactivated all bids\n`);
      } else {
        console.log(`✅ Player is already correctly sold to highest bidder. No fix needed.\n`);
        await session.abortTransaction();
        session.endSession();
        return { fixed: false, message: 'No fix needed' };
      }
    }

    if (needsFix) {
      console.log(`⚠️  FIX NEEDED:`);
      console.log(`   Current owner: ${currentOwner?.name || currentOwner?.teamName || 'None'}`);
      console.log(`   Should be: ${highestBidder?.name || highestBidder?.teamName || 'Unknown'}\n`);

      // 5. PREVIEW CHANGES
      console.log(`📊 PREVIEW OF CHANGES:\n`);

      // 5a. UserPlayer changes
      if (currentUserPlayer) {
        console.log(`   - Remove UserPlayer: ${currentOwner?.name || currentOwner?.teamName} (₹${currentUserPlayer.bidValue.toLocaleString()})`);
        console.log(`   - Refund purse: +₹${currentUserPlayer.bidValue.toLocaleString()} to ${currentOwner?.name || currentOwner?.teamName}`);
        console.log(`   - Remove from boughtPlayers: ${currentOwner?.name || currentOwner?.teamName}`);
      }
      console.log(`   - Add UserPlayer: ${highestBidder?.name || highestBidder?.teamName} (₹${highestBid.bidAmount.toLocaleString()})`);
      console.log(`   - Deduct purse: -₹${highestBid.bidAmount.toLocaleString()} from ${highestBidder?.name || highestBidder?.teamName}`);
      console.log(`   - Add to boughtPlayers: ${highestBidder?.name || highestBidder?.teamName}`);
      console.log(`   - Update Player: currentBidder=${highestBid.bidder}, currentBid=${highestBid.bidAmount}`);
      console.log(`   - Update BidHistory: mark highest bid as winner`);
      console.log(`   - Deactivate all Bid documents (player is sold)\n`);

      // 6. ASK FOR CONFIRMATION
      const confirm = await question('❓ Proceed with fix? (yes/no): ');
      if (confirm.toLowerCase() !== 'yes') {
        console.log('❌ Fix cancelled by user.\n');
        await session.abortTransaction();
        session.endSession();
        return { fixed: false, message: 'Cancelled by user' };
      }

      console.log(`\n🔧 Applying fixes...\n`);

      // 7. FIX USERPLAYER
      if (currentUserPlayer) {
        // Deactivate current UserPlayer
        currentUserPlayer.isActive = false;
        await currentUserPlayer.save({ session });
        console.log(`✅ Deactivated old UserPlayer entry`);
      }

      // Check if correct UserPlayer already exists (inactive)
      const existingCorrectUserPlayer = await UserPlayer.findOne({
        playerId: playerId,
        userId: highestBid.bidder,
        isActive: false
      }).session(session);

      if (existingCorrectUserPlayer) {
        // Reactivate it
        existingCorrectUserPlayer.isActive = true;
        existingCorrectUserPlayer.bidValue = highestBid.bidAmount;
        existingCorrectUserPlayer.updatedAt = new Date();
        await existingCorrectUserPlayer.save({ session });
        console.log(`✅ Reactivated existing UserPlayer entry for ${highestBidder?.name || highestBidder?.teamName}`);
      } else {
        // Create new UserPlayer
        const newUserPlayer = new UserPlayer({
          playerId: playerId,
          userId: highestBid.bidder,
          bidValue: highestBid.bidAmount,
          isActive: true
        });
        await newUserPlayer.save({ session });
        console.log(`✅ Created new UserPlayer entry for ${highestBidder?.name || highestBidder?.teamName}`);
      }

      // 8. FIX USER PURSES
      if (currentOwner) {
        // Refund current owner
        const currentOwnerPurse = parseFloat(currentOwner.purse.toString());
        const refundAmount = currentUserPlayer.bidValue;
        currentOwner.purse = mongoose.Types.Decimal128.fromString(
          (currentOwnerPurse + refundAmount).toString()
        );
        
        // Remove from boughtPlayers
        currentOwner.boughtPlayers = currentOwner.boughtPlayers.filter(
          pId => !pId.equals(playerId)
        );
        
        // Remove from currentBids if present
        currentOwner.currentBids = currentOwner.currentBids.filter(
          cb => !cb.playerId || !cb.playerId.equals(playerId)
        );
        
        await currentOwner.save({ session });
        console.log(`✅ Refunded ₹${refundAmount.toLocaleString()} to ${currentOwner.name || currentOwner.teamName}`);
        console.log(`✅ Removed player from ${currentOwner.name || currentOwner.teamName}'s boughtPlayers and currentBids`);
      }

      // Deduct from correct owner
      const correctOwnerPurse = parseFloat(highestBidder.purse.toString());
      
      // Check if they have this player in currentBids (locked amount)
      const lockedAmount = highestBidder.currentBids.find(
        cb => cb.playerId && cb.playerId.equals(playerId)
      )?.amount || 0;

      // Calculate final purse: current + locked - bid amount
      const finalPurse = correctOwnerPurse + lockedAmount - highestBid.bidAmount;
      highestBidder.purse = mongoose.Types.Decimal128.fromString(finalPurse.toString());

      // Add to boughtPlayers if not already there
      if (!highestBidder.boughtPlayers.some(pId => pId.equals(playerId))) {
        highestBidder.boughtPlayers.push(playerId);
      }

      // Remove from currentBids (player is sold, no longer bidding)
      highestBidder.currentBids = highestBidder.currentBids.filter(
        cb => !cb.playerId || !cb.playerId.equals(playerId)
      );

      await highestBidder.save({ session });
      console.log(`✅ Deducted ₹${highestBid.bidAmount.toLocaleString()} from ${highestBidder.name || highestBidder.teamName}`);
      console.log(`✅ Added player to ${highestBidder.name || highestBidder.teamName}'s boughtPlayers`);
      console.log(`✅ Removed player from ${highestBidder.name || highestBidder.teamName}'s currentBids`);

      // 9. FIX PLAYER DOCUMENT
      player.isSold = true;
      player.isActive = true;
      player.currentBid = highestBid.bidAmount;
      player.currentBidder = highestBid.bidder;
      if (player.currentBids !== undefined) {
        delete player.currentBids;
      }
      await player.save({ session });
      console.log(`✅ Updated Player document`);

      // 10. FIX BIDHISTORY
      let bidHistory = await BidHistory.findOne({ playerId: playerId }).session(session);
      
      if (!bidHistory) {
        // Create new BidHistory
        bidHistory = new BidHistory({
          playerId: playerId,
          bidID: highestBid._id,
          bids: allBids.map(bid => ({
            userID: bid.bidder,
            bidAmount: bid.bidAmount,
            status: bid._id.equals(highestBid._id),
            createdAt: bid.createdAt || bid.timestamp,
            updatedAt: bid.updatedAt || bid.timestamp
          }))
        });
        await bidHistory.save({ session });
        console.log(`✅ Created BidHistory`);
      } else {
        // Update existing BidHistory
        bidHistory.bidID = highestBid._id;
        bidHistory.bids = allBids.map(bid => ({
          ...bid.toObject ? bid.toObject() : bid,
          userID: bid.bidder,
          bidAmount: bid.bidAmount,
          status: bid._id.equals(highestBid._id),
          createdAt: bid.createdAt || bid.timestamp,
          updatedAt: bid.updatedAt || bid.timestamp
        }));
        await bidHistory.save({ session });
        console.log(`✅ Updated BidHistory`);
      }
    }

    // 11. FIX BID DOCUMENTS (Always do this if player is sold)
    // IMPORTANT: When a player is SOLD, ALL bids should be deactivated
    // The winning bid should have isActive: false and isBidOn: false because the player is no longer being bid on
    const bidUpdateResult = await Bid.updateMany(
      { playerId: playerId },
      { $set: { isActive: false, isBidOn: false } }
    ).session(session);
    console.log(`✅ Deactivated ${bidUpdateResult.modifiedCount} bid document(s) (player is sold, no longer bidding)`);

    // 12. COMMIT TRANSACTION
    await session.commitTransaction();
    console.log(`\n✅ Transaction committed successfully!\n`);

    // 13. VERIFY
    console.log(`🔍 VERIFICATION:\n`);
    const verifyPlayer = await Player.findById(playerId);
    const verifyUserPlayer = await UserPlayer.findOne({ playerId: playerId, isActive: true });
    const verifyOwner = verifyUserPlayer ? await User.findById(verifyUserPlayer.userId) : null;
    const verifyActiveBids = await Bid.countDocuments({
      playerId: playerId,
      isActive: true,
      isBidOn: true
    });
    
    console.log(`   Player.isSold: ${verifyPlayer.isSold}`);
    console.log(`   Player.currentBidder: ${verifyPlayer.currentBidder}`);
    console.log(`   Player.currentBid: ₹${verifyPlayer.currentBid?.toLocaleString() || 'N/A'}`);
    console.log(`   UserPlayer.owner: ${verifyOwner?.name || verifyOwner?.teamName || 'N/A'}`);
    console.log(`   UserPlayer.bidValue: ₹${verifyUserPlayer?.bidValue.toLocaleString() || 'N/A'}`);
    console.log(`   Owner.purse: ₹${verifyOwner?.purse ? parseFloat(verifyOwner.purse.toString()).toLocaleString() : 'N/A'}`);
    console.log(`   Active bids: ${verifyActiveBids} (should be 0)\n`);

    session.endSession();
    return {
      fixed: true,
      playerId: playerId,
      playerName: player.name,
      oldOwner: currentOwner ? {
        name: currentOwner.name || currentOwner.teamName,
        userId: currentOwner._id,
        refunded: currentUserPlayer?.bidValue
      } : null,
      newOwner: {
        name: highestBidder.name || highestBidder.teamName,
        userId: highestBid.bidder,
        bidAmount: highestBid.bidAmount
      }
    };

  } catch (error) {
    await session.abortTransaction();
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
    session.endSession();
    throw error;
  }
}

async function main() {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, dbName });
    console.log('✅ Connected to MongoDB\n');

    const playerId = process.argv[2];
    if (!playerId) {
      console.error('❌ Please provide a player ID');
      console.error('Usage: node scripts/fixPlayerSale.js <playerId>');
      process.exit(1);
    }

    if (!mongoose.isValidObjectId(playerId)) {
      console.error(`❌ Invalid player ID: ${playerId}`);
      process.exit(1);
    }

    const result = await fixPlayerSale(playerId);
    
    if (result.fixed) {
      console.log(`\n✅ Fix completed successfully!`);
      console.log(`   Player: ${result.playerName}`);
      if (result.oldOwner) {
        console.log(`   Old Owner: ${result.oldOwner.name} (refunded ₹${result.oldOwner.refunded.toLocaleString()})`);
      }
      console.log(`   New Owner: ${result.newOwner.name} (₹${result.newOwner.bidAmount.toLocaleString()})\n`);
    }

    await mongoose.disconnect();
    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    await mongoose.disconnect().catch(() => {});
    rl.close();
    process.exit(1);
  }
}

main();

