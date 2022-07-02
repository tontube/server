const express = require('express')
const fs = require('fs')
const path = require('path')
const app = express()
const url = require('url');





const TonWeb = require("tonweb");
const BN = TonWeb.utils.BN;
const toNano = TonWeb.utils.toNano;
const providerUrl = 'https://testnet.toncenter.com/api/v2/jsonRPC'; // TON HTTP API url. Use this url for testnet
const apiKey = '022f03fdcf8fdb207d992eb05a05fce5a4e91208a2dfea87add8a3f59213c858'; // Obtain your API key in https://t.me/tontestnetapibot
const tonweb = new TonWeb(new TonWeb.HttpProvider(providerUrl, {apiKey})); // Initialize TON SDK

const seedA = TonWeb.utils.base64ToBytes('vt58J2v6FaSuXFGcyGtqT5elpVxcZ+I1zgu/GUfA5uY='); // A's private (secret) key
const keyPairA = tonweb.utils.keyPairFromSeed(seedA); // Obtain key pair (public key and private key)
const walletA = tonweb.wallet.create({
	publicKey: keyPairA.publicKey
});
var walletAddressA

const init = async () => {
	walletAddressA = await walletA.getAddress(); // address of this wallet in blockchain
	console.log('walletAddressA = ', walletAddressA.toString(true, true, true));
}

init();








var clients = {};
var previousSecret;
var currentSecret;




app.use(express.static(path.join(__dirname, 'public')))

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname + '/index.htm'))
})

app.get('/getVideo', function(req, res) {
	const secret = url.parse(req.url,true).query.secret;

	const now = Date.now() / 1000;

	const partDuration = 30;
	const lastPartDuration = 8
	const duration = partDuration * 9 + lastPartDuration;

	const progress = now % duration;

	var seek = 0;
	var index = 0;
	var indexDuration = index < 9 ? partDuration : lastPartDuration;

	while (progress > seek + indexDuration) {
		index++;
		seek += indexDuration;
		indexDuration = index < 9 ? partDuration : lastPartDuration;
	}

	if (secret == previousSecret) {
		if (seek + indexDuration - progress < 2) {
			// Current index is fine
		}
		else {
			index--;

			if (index < 0) {
				index = 9;
			}
		}
	}
	else if (secret == currentSecret) {
		// Current index is fine
	}
	else {
		console.log('Wrong secret!');
		const head = {
			'Content-Type': 'plain/text',
		}
		res.writeHead(400, head)
		return;
	}

	console.log('index = ', index);

	const path = index + '.mp4'
	const stat = fs.statSync(path)
	const fileSize = stat.size
	const range = req.headers.range

	if (range) {
		const parts = range.replace(/bytes=/, "").split("-")
		const start = parseInt(parts[0], 10)
		const end = parts[1]
			? parseInt(parts[1], 10)
			: fileSize-1

		if(start >= fileSize) {
			res.status(416).send('Requested range not satisfiable\n'+start+' >= '+fileSize);
			return
		}

		const chunksize = (end-start)+1
		const file = fs.createReadStream(path, {start, end})
		const head = {
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': chunksize,
			'Content-Type': 'video/mp4',
		}

		res.writeHead(206, head)
		file.pipe(res)
	} else {
		const head = {
			'Content-Length': fileSize,
			'Content-Type': 'video/mp4',
		}
		res.writeHead(200, head)
		fs.createReadStream(path).pipe(res)
	}
})

app.listen(3001, function () {
  console.log('Listening on port 3001!')
})





const { Server } = require("socket.io");

const io = new Server({
	allowEIO3: true,
	cors: {
		credentials: false,
		origin: "http://localhost:3000/",
		methods: ["GET", "POST"]
	}
  });

io.on("connection", (socket) => {
	console.log(socket.id);

	socket.on("publicKey", (...args) => {
		socket.emit("publicKey", keyPairA.publicKey, walletAddressA);
	});

	socket.on("latestState", (...args) => {
		var clientPublicKey = args[0];
		socket.emit("latestState", clients[clientPublicKey] == null ? null : clients[clientPublicKey].latestState);
	});

	socket.on("newChannel", (...args) => {
		const process = async () => {
			var latestState = args[0];
			var clientPublicKey = latestState.client_public_key;

			if (latestState.server_balance != 0.01) {
				console.log('invalid initial balance for server.');
				return;
			}

			if (latestState.client_sequence_number != 1) {
				console.log('First client sequence must be 1.');
				return;
			}

			const channelConfig = {
				channelId: latestState.channel_id,
				addressA: latestState.client_wallet_address,
				addressB: walletAddressA,
				initBalanceA: toNano(String(parseFloat(latestState.client_balance) + 0.01)),
				initBalanceB: toNano('0')
			}

			const channel = tonweb.payments.createChannel({
				...channelConfig,
				isA: false,
				myKeyPair: keyPairA,
				hisPublicKey: clientPublicKey,
			});

			const channelAddress = await channel.getAddress();
			if (channelAddress.toString(true, true, true) != latestState.channel_address) {
				console.log('invalid channel address.');
				return;
			}

			const expectedState = {
				balanceA: toNano(String(latestState.client_balance)),
				balanceB: toNano('0.01'),
				seqnoA: new BN(1),
				seqnoB: new BN(0)
			};

			if (!(await channel.verifyState(expectedState, latestState.client_signature))) {
				console.log('Signature did not match with the expected state.');
				return;
			}

			if (clients[clientPublicKey] == null) {
				clients[clientPublicKey] = {};
			}

			clients[clientPublicKey].latestState = latestState;
			clients[clientPublicKey].streaming = false;

			socket.emit("latestState", latestState);
		}

		process();
	});

	socket.on("play", (...args) => {
		var clientPublicKey = args[0];

		if (clients[clientPublicKey] == null) {
			console.log('Play called but client not found.');
			return;
		}

		clients[clientPublicKey].streaming = true;
		clients[clientPublicKey].sendPreviousSecret = true;
		clients[clientPublicKey].pendingPayment = true;
		clients[clientPublicKey].socket = socket;
		socket.emit("pay");
	});

	socket.on("pay", (...args) => {
		const process = async () => {
			var newState = args[0];
			var clientPublicKey = newState.client_public_key;

			if (clients[client_public_key] == null) {
				console.log('Payment received for a client that doesn\'t exist.');
				return;
			}

			var latestState = clients[client_public_key].latestState;

			if (latestState == null) {
				console.log('Payment recived but state does not exist');
				return;
			}

			const channelConfig = {
				channelId: latestState.channel_id,
				addressA: latestState.client_wallet_address,
				addressB: walletAddressA,
				initBalanceA: toNano(String(parseFloat(latestState.client_balance) + parseFloat(latestState.server_balance))),
				initBalanceB: toNano('0')
			}

			const channel = tonweb.payments.createChannel({
				...channelConfig,
				isA: false,
				myKeyPair: keyPairA,
				hisPublicKey: clientPublicKey,
			});

			const expectedState = {
				balanceA: toNano(String(parseFloat(latestState.client_balance) - 0.01)),
				balanceB: toNano(String(parseFloat(latestState.server_balance) + 0.01)),
				seqnoA: new BN(latestState.client_sequence_number + 1),
				seqnoB: new BN(0)
			};

			if (!(await channel.verifyState(expectedState, newState.client_signature))) {
				console.log('Signature did not match with the expected state.');
				return;
			}

			clients[clientPublicKey].latestState = newState;

			clients[clientPublicKey].pendingPayment = false;

			if (clients[clientPublicKey].sendPreviousSecret) {
				clients[clientPublicKey].sendPreviousSecret = false;
				socket.emit("secret", previousSecret);
			} else {
				socket.emit("secret", currentSecret);
			}
		}

		process();
	});
});
io.listen(3030);

console.log('socket.io listening on 3030');










const now = Date.now() / 1000;

const partDuration = 30;
const lastPartDuration = 8
const duration = partDuration * 9 + lastPartDuration;

const progress = now % duration;

var seek = 0;
var index = 0;
var indexDuration = index < 9 ? partDuration : lastPartDuration;

while (progress > seek + indexDuration) {
	index++;
	seek += indexDuration;
	indexDuration = index < 9 ? partDuration : lastPartDuration;
}

previousSecret = String(Math.random());
currentSecret = previousSecret;

var nextTime = Math.max(seek + indexDuration - progress - 2, 0);

function updater() {
	previousSecret = currentSecret;
	currentSecret = String(Math.random());

	console.log('new secret: ' + currentSecret);

	index++;
	var indexDuration = index < 9 ? partDuration : lastPartDuration;

	setTimeout(updater, indexDuration * 1000);

	for (clientPublicKey in clients) {
		if (clients[clientPublicKey].streaming) {
			if (clients[clientPublicKey].pendingPayment || clients[clientPublicKey].socket == null) {
				clients[clientPublicKey].streaming = false;
				continue;
			}

			clients[clientPublicKey].pendingPayment = true;
			clients[clientPublicKey].socket.emit("pay");
		}
	}
};

setTimeout(updater, nextTime * 1000);
