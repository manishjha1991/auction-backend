const mongoose = require('mongoose');
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const BidHistory = require('../models/BidHistory');

const toNumber = (value = 0) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  return Number(value.toString()) || 0;
};

const snapshotUser = (user) =>
  user
    ? {
        userId: user._id.toString(),
        name: user.name || 'Unknown',
        teamName: user.teamName || user.name || 'Unknown Team',
      }
    : null;

const determineWinner = async (playerDoc, session) => {
  const currentBidUsers = await User.find({
    'currentBids.playerId': playerDoc._id,
  })
    .select('_id currentBids')
    .lean()
    .session(session || null);

  if (currentBidUsers.length > 0) {
    let highest = null;
    currentBidUsers.forEach((user) => {
      user.currentBids
        .filter((bid) => bid.playerId.toString() === playerDoc._id.toString())
        .forEach((bid) => {
          const amount = toNumber(bid.amount);
          if (!highest || amount > highest.amount) {
            highest = { userId: user._id.toString(), amount, source: 'currentBids' };
          }
        });
    });
    if (highest) return highest;
  }

  const activeLink = await UserPlayer.findOne({
    playerId: playerDoc._id,
    isActive: true,
  })
    .lean()
    .session(session || null);

  if (activeLink) {
    return {
      userId: activeLink.userId.toString(),
      amount: toNumber(activeLink.bidValue),
      source: 'userPlayer',
    };
  }

  if (playerDoc.currentBidder) {
    return {
      userId: playerDoc.currentBidder.toString(),
      amount: toNumber(playerDoc.currentBid),
      source: 'player',
    };
  }

  const highestBid = await Bid.find({ playerId: playerDoc._id })
    .sort({ bidAmount: -1, updatedAt: -1, timestamp: -1 })
    .limit(1)
    .lean()
    .session(session || null);

  if (highestBid.length > 0) {
    return {
      userId: highestBid[0].bidder.toString(),
      amount: toNumber(highestBid[0].bidAmount),
      source: 'bids',
    };
  }

  return null;
};

async function analyzePlayer(player, session, options = {}) {
  const playerId = player._id || player;
  const playerDoc =
    typeof player === 'object' && player._id ? player : await Player.findById(playerId).session(session || null);
  if (!playerDoc) {
    return {
      status: 'missing',
      playerId: playerId?.toString(),
    };
  }

  const winner = await determineWinner(playerDoc, session);
  const activeLink = await UserPlayer.findOne({
    playerId: playerDoc._id,
    isActive: true,
  })
    .lean()
    .session(session || null);

  const currentOwnerUser = activeLink
    ? await User.findById(activeLink.userId).select('name teamName').lean().session(session || null)
    : null;
  const desiredOwner = winner
    ? await User.findById(winner.userId).select('name teamName').lean().session(session || null)
    : null;

  const usersWithLockedBids = await User.countDocuments({
    'currentBids.playerId': playerDoc._id,
  }).session(session || null);

  const needsFix =
    !winner ||
    !desiredOwner ||
    !activeLink ||
    activeLink.userId.toString() !== winner.userId ||
    Number(activeLink.bidValue) !== Number(winner.amount) ||
    usersWithLockedBids > 0;

  return {
    status: needsFix ? 'needs-fix' : 'ok',
    playerId: playerDoc._id.toString(),
    name: playerDoc.name,
    type: playerDoc.type,
    currentOwner: snapshotUser(currentOwnerUser),
    desiredOwner: snapshotUser(desiredOwner),
    desiredAmount: winner?.amount || null,
    hasLockedBidders: usersWithLockedBids > 0,
    fromCurrentBids: options.fromCurrentBids || false,
  };
}

async function previewAuctionFixes() {
  const soldPlayers = await Player.find({ isSold: true })
    .select('name type currentBid currentBidder')
    .lean();

  const soldMap = new Map(soldPlayers.map((p) => [p._id.toString(), p]));

  const usersWithBids = await User.find({ 'currentBids.0': { $exists: true } })
    .select('currentBids')
    .lean();

  const currentBidPlayerIds = new Set();
  usersWithBids.forEach((user) => {
    (user.currentBids || []).forEach((bid) => {
      if (bid.playerId) {
        currentBidPlayerIds.add(bid.playerId.toString());
      }
    });
  });

  const extraPlayerIds = [...currentBidPlayerIds].filter((id) => !soldMap.has(id));
  const extraPlayers = extraPlayerIds.length
    ? await Player.find({ _id: { $in: extraPlayerIds } })
        .select('name type currentBid currentBidder')
        .lean()
    : [];

  const candidates = [...soldPlayers, ...extraPlayers];

  const players = [];
  let needsFix = 0;
  let missingWinner = 0;

  for (const player of candidates) {
    const fromCurrentBids = currentBidPlayerIds.has(player._id.toString());
    const report = await analyzePlayer(player, null, { fromCurrentBids });
    players.push(report);
    if (report.status === 'needs-fix') needsFix += 1;
    if (!report.desiredOwner) missingWinner += 1;
  }

  const playersNeedingFix = players.filter((p) => p.status === 'needs-fix');

  return {
    summary: {
      totalSoldPlayers: soldPlayers.length,
      totalPlayersChecked: candidates.length,
      referencedInCurrentBids: currentBidPlayerIds.size,
      needsFix,
      missingWinner,
      alreadyCorrect: candidates.length - needsFix,
    },
    players,
    fixCandidateIds: playersNeedingFix.map((p) => p.playerId),
  };
}

async function fixPlayer(playerId, session) {
  const player = await Player.findById(playerId).session(session);
  if (!player) {
    return { status: 'error', message: 'Player not found' };
  }

  const winner = await determineWinner(player, session);
  if (!winner) {
    return { status: 'skipped', reason: 'no-winner' };
  }

  const desiredUser = await User.findById(winner.userId).session(session);
  if (!desiredUser) {
    return { status: 'error', message: 'Winning user not found' };
  }

  const usersWithLockedBids = await User.find({
    'currentBids.playerId': player._id,
  }).session(session);

  let winnerLockedAmount = 0;
  for (const user of usersWithLockedBids) {
    const bidEntry = user.currentBids.find(
      (bid) => bid.playerId.toString() === player._id.toString()
    );
    if (!bidEntry) continue;

    const lockedAmount = toNumber(bidEntry.amount);

    if (user._id.toString() === winner.userId) {
      winnerLockedAmount = lockedAmount;
    } else {
      const purseValue = toNumber(user.purse);
      const newCurrentBids = user.currentBids.filter(
        (bid) => bid.playerId.toString() !== player._id.toString()
      );
      const updateDoc = {
        currentBids: newCurrentBids,
      };
      if (lockedAmount > 0) {
        updateDoc.purse = mongoose.Types.Decimal128.fromString(
          (purseValue + lockedAmount).toFixed(2)
        );
      }
      await User.updateOne({ _id: user._id }, { $set: updateDoc }, { session });
    }
  }

  const nonWinnerUsers = await User.find({
    boughtPlayers: player._id,
    _id: { $ne: winner.userId },
  }).session(session);

  for (const user of nonWinnerUsers) {
    const updatedBought = user.boughtPlayers.filter(
      (pid) => pid.toString() !== player._id.toString()
    );
    await User.updateOne(
      { _id: user._id },
      { $set: { boughtPlayers: updatedBought } },
      { session }
    );
  }

  const previousLinks = await UserPlayer.find({ playerId: player._id }).session(session);
  for (const link of previousLinks) {
    if (link.userId.toString() === winner.userId) continue;
    if (link.isActive) {
      const owner = await User.findById(link.userId).session(session);
      if (owner) {
        const newPurse = mongoose.Types.Decimal128.fromString(
          (toNumber(owner.purse) + toNumber(link.bidValue)).toFixed(2)
        );
        const newBought = owner.boughtPlayers.filter(
          (pid) => pid.toString() !== player._id.toString()
        );
        await User.updateOne(
          { _id: owner._id },
          { $set: { purse: newPurse, boughtPlayers: newBought } },
          { session }
        );
      }
    }
    link.isActive = false;
    link.updatedAt = new Date();
    await link.save({ session });
  }

  const purseValue = toNumber(desiredUser.purse);
  const newWinnerPurse = mongoose.Types.Decimal128.fromString(
    (purseValue + winnerLockedAmount - winner.amount).toFixed(2)
  );
  const winnerCurrentBids = (desiredUser.currentBids || []).filter(
    (bid) => bid.playerId.toString() !== player._id.toString()
  );
  const winnerBought = desiredUser.boughtPlayers || [];
  if (!winnerBought.some((pid) => pid.toString() === player._id.toString())) {
    winnerBought.push(player._id);
  }

  await User.updateOne(
    { _id: desiredUser._id },
    {
      $set: {
        purse: newWinnerPurse,
        currentBids: winnerCurrentBids,
        boughtPlayers: winnerBought,
      },
    },
    { session }
  );

  await UserPlayer.updateOne(
    { playerId: player._id },
    {
      $set: {
        userId: winner.userId,
        bidValue: winner.amount,
        isActive: true,
        updatedAt: new Date(),
      },
    },
    { upsert: true, session }
  );

  player.isSold = true;
  player.isActive = true;
  player.currentBid = winner.amount;
  player.currentBidder = winner.userId;
  await player.save({ session });

  await Bid.updateMany(
    { playerId: player._id },
    { $set: { isActive: false, isBidOn: false } }
  ).session(session);

  const winningBid = await Bid.findOne({
    playerId: player._id,
    bidder: winner.userId,
  })
    .sort({ bidAmount: -1 })
    .session(session);

  if (winningBid) {
    winningBid.isActive = true;
    winningBid.isBidOn = false;
    await winningBid.save({ session });
  }

  const bidHistory = await BidHistory.findOne({ playerId: player._id }).session(session);
  if (bidHistory) {
    bidHistory.bids = bidHistory.bids.map((entry) => ({
      ...entry.toObject(),
      status:
        entry.userID?.toString() === winner.userId &&
        Number(entry.bidAmount) === Number(winner.amount),
    }));
    await bidHistory.save({ session });
  }

  return {
    status: 'fixed',
    owner: snapshotUser(desiredUser),
    amount: winner.amount,
  };
}

async function executeAuctionFixes(options = {}) {
  const { playerIds } = options;

  const filter =
    playerIds && playerIds.length
      ? { _id: { $in: playerIds.map((id) => new mongoose.Types.ObjectId(id)) } }
      : { isSold: true };

  const players = await Player.find(filter).select('name').lean();
  const summary = {
    processed: players.length,
    fixed: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };
  const details = [];

  for (const player of players) {
    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction(() => fixPlayer(player._id, session));
      details.push({
        playerId: player._id.toString(),
        name: player.name,
        ...result,
      });
      if (result.status === 'fixed') summary.fixed += 1;
      else if (result.status === 'unchanged') summary.unchanged += 1;
      else if (result.status === 'skipped') summary.skipped += 1;
      else if (result.status === 'error') summary.errors += 1;
    } catch (err) {
      summary.errors += 1;
      details.push({
        playerId: player._id.toString(),
        name: player.name,
        status: 'error',
        message: err.message,
      });
    } finally {
      await session.endSession();
    }
  }

  return { summary, details };
}

module.exports = {
  previewAuctionFixes,
  executeAuctionFixes,
};

