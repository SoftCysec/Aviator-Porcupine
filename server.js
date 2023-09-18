const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
require('dotenv').config();

// Create an instance of the Express app
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Firebase initialization
const serviceAccount = require('./porcupine-aviator-firebase-adminsdk-iafqf-e70b310eec.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Middleware for Token Verification
const verifyToken = (req, res, next) => {
    const idToken = req.headers.authorization;
    if (!idToken) {
        return res.status(403).send('Missing Authorization Token');
    }
    admin.auth().verifyIdToken(idToken)
        .then((decodedToken) => {
            const uid = decodedToken.uid;
            req.uid = uid;
            next();
        })
        .catch((error) => {
            console.error('Token verification failed:', error);
            res.status(403).send('Invalid Token or Unauthorized');
        });
};

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

// Routes
app.get('/profile', verifyToken, (req, res) => {
    res.json({ uid: req.uid });
});

app.post('/profile', verifyToken, (req, res) => {
    const displayName = req.body.displayName;
    res.json({ message: `Display name updated to ${displayName}` });
});

// Fetch latest Aviator game state
const fetchLatestAviatorState = async() => {
    const options = {
        method: 'GET',
        url: process.env.BASEURL_AViator,
        headers: {
            'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': process.env.RAPIDAPI_HOST
        }
    };

    try {
        const response = await axios.request(options);
        return response.data;
    } catch (error) {
        console.error("Error fetching latest Aviator state:", error);
    }
};

// Endpoint to get latest Aviator game state for the frontend
app.get('/aviator-latest', async(req, res) => {
    const latestState = await fetchLatestAviatorState();
    res.json(latestState);
});

// Betting Endpoints
app.post('/placeBet', verifyToken, async(req, res) => {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).send("Invalid bet amount");
    }

    const userRef = admin.firestore().collection('users').doc(req.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        return res.status(404).send("User not found");
    }

    const userBalance = userDoc.data().balance;

    if (amount > userBalance) {
        return res.status(400).send("Insufficient funds");
    }

    await admin.firestore().runTransaction(async(transaction) => {
        transaction.update(userRef, { balance: userBalance - amount });
        transaction.set(admin.firestore().collection('bets').doc(), {
            uid: req.uid,
            amount,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            outcome: 'pending'
        });
    });

    res.status(201).send("Bet placed");
});

app.get('/betHistory', verifyToken, async(req, res) => {
    const betSnapshots = await admin.firestore().collection('bets').where('uid', '==', req.uid).get();
    const betHistory = [];
    betSnapshots.forEach(doc => {
        betHistory.push({ id: doc.id, ...doc.data() });
    });
    res.json(betHistory);
});


// M-Pesa Configuration
const {
    MPESA_CONSUMER_KEY,
    MPESA_CONSUMER_SECRET,
    MPESA_SHORT_CODE,
    MPESA_LIPA_NA_MPESA_ONLINE_PASSKEY,
    MPESA_INITIATOR_NAME,
    MPESA_SECURITY_CREDENTIAL,
    MPESA_AOTH_GEN,
    WITHDRAW_REQUEST_URL,
    BALANCE_QUERY_URL,
    STK_PUSH_URL,
    STK_CALLBACK_URL,
    B2C_TIMEOUT_URL,
    B2C_RESULT_URL,
    BALANCE_TIMEOUT_URL,
    BALANCE_RESULT_URL
} = process.env;

const MAX_WIN_AMOUNT = 3000;
const WIN_COMMISSION_PERCENTAGE = 10;
const LOSS_COMMISSION_PERCENTAGE = 30;

let mpesaAuthToken = null;

const getMpesaAuthToken = async() => {
    const auth = 'Basic ' + new Buffer.from(MPESA_CONSUMER_KEY + ':' + MPESA_CONSUMER_SECRET).toString('base64');
    try {
        const response = await axios.get(MPESA_AOTH_GEN, {
            headers: {
                Authorization: auth
            }
        });
        mpesaAuthToken = response.data.access_token;
    } catch (error) {
        console.error("Error fetching M-Pesa token:", error);
    }
};

getMpesaAuthToken();
setInterval(getMpesaAuthToken, 3000000);

const calculateFinalAmount = (betAmount, outcome) => {
    if (outcome === "win") {
        const commission = (WIN_COMMISSION_PERCENTAGE / 100) * MAX_WIN_AMOUNT;
        return MAX_WIN_AMOUNT - commission;
    } else { // Assuming any other outcome is a loss
        const commission = (LOSS_COMMISSION_PERCENTAGE / 100) * betAmount;
        return betAmount - commission;
    }
};

// Deposit - STK Push
app.post('/deposit', verifyToken, async(req, res) => {
    const { phoneNumber, amount } = req.body;
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const password = new Buffer.from(MPESA_SHORT_CODE + MPESA_LIPA_NA_MPESA_ONLINE_PASSKEY + timestamp).toString('base64');

    try {
        const response = await axios.post(STK_PUSH_URL, {
            BusinessShortCode: MPESA_SHORT_CODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: phoneNumber,
            PartyB: MPESA_SHORT_CODE,
            PhoneNumber: phoneNumber,
            CallBackURL: STK_CALLBACK_URL,
            AccountReference: "AviatorDeposit",
            TransactionDesc: "Deposit to Aviator"
        }, {
            headers: {
                Authorization: 'Bearer ' + mpesaAuthToken
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error("Error initiating STK Push:", error);
        res.status(500).send("Error initiating payment.");
    }
});

// Withdrawal - B2C
app.post('/withdraw', verifyToken, async(req, res) => {
    const { phoneNumber, amount, outcome } = req.body; // We assume 'outcome' is sent with the request
    const finalAmount = calculateFinalAmount(amount, outcome);

    try {
        const response = await axios.post(WITHDRAW_REQUEST_URL, {
            InitiatorName: MPESA_INITIATOR_NAME,
            SecurityCredential: MPESA_SECURITY_CREDENTIAL,
            CommandID: "BusinessPayment",
            Amount: finalAmount,
            PartyA: MPESA_SHORT_CODE,
            PartyB: phoneNumber,
            Remarks: "Transaction from Aviator",
            QueueTimeOutURL: B2C_TIMEOUT_URL,
            ResultURL: B2C_RESULT_URL,
            Occasion: "Transaction"
        }, {
            headers: {
                Authorization: 'Bearer ' + mpesaAuthToken
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error("Error initiating B2C transaction:", error);
        res.status(500).send("Error initiating transaction.");
    }
});

// Balance Inquiry
app.get('/balance', verifyToken, async(req, res) => {
    try {
        const response = await axios.post(BALANCE_QUERY_URL, {
            Initiator: MPESA_INITIATOR_NAME,
            SecurityCredential: MPESA_SECURITY_CREDENTIAL,
            CommandID: "AccountBalance",
            PartyA: MPESA_SHORT_CODE,
            IdentifierType: "4",
            Remarks: "Checking account balance",
            QueueTimeOutURL: BALANCE_TIMEOUT_URL,
            ResultURL: BALANCE_RESULT_URL
        }, {
            headers: {
                Authorization: 'Bearer ' + mpesaAuthToken
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error("Error checking balance:", error);
        res.status(500).send("Error checking balance.");
    }
});



// Set up the HTTP server and Socket.io
const server = http.createServer(app);
const io = socketIo(server);

io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});