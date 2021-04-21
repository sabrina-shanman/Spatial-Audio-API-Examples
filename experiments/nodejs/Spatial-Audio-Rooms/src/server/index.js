const isInProdMode = process.argv.slice(2)[0] === "prod";

console.warn(`*****\nServer production mode status: ${isInProdMode}\n*****\n`);

const webpack = require('webpack');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = 8180;

if (!isInProdMode) {
    const webpackHotMiddleware = require('webpack-hot-middleware');
    const webpackDevMiddleware = require('webpack-dev-middleware');
    const chokidar = require('chokidar');

    const WEBPACK_CONFIG = require('../../webpack.config.js')();
    const WEBPACK_COMPILER = webpack(WEBPACK_CONFIG);

    const devMiddleWare = webpackDevMiddleware(WEBPACK_COMPILER, { publicPath: WEBPACK_CONFIG.output.publicPath, });
    const hotMiddleware = webpackHotMiddleware(WEBPACK_COMPILER, {
        'log': console.log,
        'path': '/__webpack_hmr',
        'heartbeat': 2000,
        'reload': true
    });

    app.use(devMiddleWare);
    app.use(hotMiddleware);

    const watcher = chokidar.watch('./src/server');
    watcher.on('ready', () => {
        watcher.on('all', () => {
            console.log("Clearing server module cache...");
            hotMiddleware.publish({ action: 'reload' });
            Object.keys(require.cache).forEach((id) => {
                if (/[\/\\]server[\/\\]/.test(id)) {
                    delete require.cache[id];
                }
            });
        });
    });

    WEBPACK_COMPILER.hooks.compilation.tap('ClearClientModuleCachePlugin', (stats) => {
        console.log("Clearing client module cache...");
        hotMiddleware.publish({ action: 'reload' });
        Object.keys(require.cache).forEach((id) => {
            if (/[\/\\]client[\/\\]/.test(id)) {
                delete require.cache[id];
            }
        });
    });
}

const DIST_DIR = path.join(__dirname, "..", "..", "dist");
app.use('/spatial-audio-rooms', express.static(DIST_DIR));
app.use(require('body-parser').urlencoded({ extended: true }));

app.get('/spatial-audio-rooms', async (req, res, next) => {
    require('./serverRender')(isInProdMode, req, async (err, page) => {
        if (err) {
            return next(err);
        }
        res.send(page);
    });
});

app.post('/spatial-audio-rooms/create', (req, res, next) => {
    let spaceURL;

    let slackCommandText = req.body.text;
    if (slackCommandText && slackCommandText.length > 0) {
        spaceURL = `https://experiments.highfidelity.com/spatial-audio-rooms/?spaceName=${slackCommandText}`;

        res.json({
            "response_type": 'in_channel',
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `<${spaceURL}|Click here to join the Spatial Audio Room named "${slackCommandText}".>`
                    }
                }
            ]
        });
    } else {
        let stringToHash;

        let slackChannelID = req.body.channel_id;
        if (slackChannelID) {
            stringToHash = slackChannelID;
        }

        if (!stringToHash) {
            console.error(`Couldn't generate Spatial Audio Room link. Request body:\n${JSON.stringify(req.body)}`);
            res.json({
                "response_type": "ephemeral",
                "text": "Sorry, I couldn't generate a Spatial Audio Room for you. Please contact Zach."
            });
            return;
        }

        let hash = crypto.createHash('md5').update(stringToHash).digest('hex');
        spaceURL = `https://experiments.highfidelity.com/spatial-audio-rooms/?spaceName=${hash}`;

        res.json({
            "response_type": 'in_channel',
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": `<${spaceURL}|Click here to join the Spatial Audio Room associated with this Slack channel.>`
                    }
                }
            ]
        });
    }
});

const http = require("http").createServer(app);

const socketIOServer = require("socket.io")(http, {
    path: '/spatial-audio-rooms/socket.io',
    cors: {
        origin: `http://localhost:${PORT}`,
        methods: ["GET", "POST"]
    }
});

socketIOServer.on("error", (e) => {
    console.error(e);
});

class ServerSpaceInfo {
    constructor({ spaceName } = {}) {
        this.spaceName = spaceName;
        this.participants = [];
    }
}

class Participant {
    constructor({ socketID, spaceName, visitIDHash, currentSeatID, displayName, colorHex, echoCancellationEnabled, agcEnabled, hiFiGainSliderValue, volumeThreshold, } = {}) {
        this.socketID = socketID;
        this.spaceName = spaceName;
        this.visitIDHash = visitIDHash;
        this.currentSeatID = currentSeatID;
        this.displayName = displayName;
        this.colorHex = colorHex;
        this.echoCancellationEnabled = echoCancellationEnabled;
        this.agcEnabled = agcEnabled;
        this.hiFiGainSliderValue = hiFiGainSliderValue;
        this.volumeThreshold = volumeThreshold;
    }
}

function onWatchNewVideo(newVideoURL, spaceName, roomName) {
    if (!spaceInformation[spaceName][roomName]) {
        console.error(`In \`onWatchNewVideo()\`, no \`spaceInformation["${spaceName}"]["${roomName}"]\`!`);
        return;
    }

    let url = new URL(newVideoURL);

    let youTubeVideoID;
    if (url.hostname === "youtu.be") {
        youTubeVideoID = url.pathname.substr(1);
    } else if (url.hostname === "www.youtube.com" || url.hostname  === "youtube.com") {
        const params = new URLSearchParams(url.search);
        youTubeVideoID = params.get("v");
    }
    
    if (youTubeVideoID) {
        spaceInformation[spaceName][roomName].currentQueuedVideoURL = newVideoURL;
        console.log(`Emitting \`watchNewYouTubeVideo\` with Video ID \`${youTubeVideoID}\` to all users in ${spaceName}/${roomName}...`);

        socketIOServer.sockets.in(spaceName).emit("watchNewYouTubeVideo", roomName, youTubeVideoID, spaceInformation[spaceName].currentVideoSeekTime);
    }
}

let spaceInformation = {};
socketIOServer.on("connection", (socket) => {
    socket.on("addParticipant", ({ spaceName, visitIDHash, currentSeatID, displayName, colorHex, echoCancellationEnabled, agcEnabled, hiFiGainSliderValue, volumeThreshold, } = {}) => {
        if (!spaceInformation[spaceName]) {
            spaceInformation[spaceName] = new ServerSpaceInfo({ spaceName });
        }

        if (spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === visitIDHash; })) {
            // Already had info about this participant.
            return;
        }

        console.log(`${Date.now()}: In ${spaceName}, adding participant:\nHashed Visit ID: \`${visitIDHash}\`\nDisplay Name: \`${displayName}\`\nColor: ${colorHex}\n`);

        let me = new Participant({
            socketID: socket.id,
            spaceName,
            visitIDHash,
            currentSeatID,
            displayName,
            colorHex,
            echoCancellationEnabled,
            agcEnabled,
            hiFiGainSliderValue,
            volumeThreshold,
        });

        spaceInformation[spaceName].participants.push(me);

        socket.join(spaceName);

        socket.to(spaceName).emit("onParticipantsAddedOrEdited", [me]);
        socket.emit("onParticipantsAddedOrEdited", spaceInformation[spaceName].participants.filter((participant) => { return participant.visitIDHash !== visitIDHash; }));
    });

    socket.on("editParticipant", ({ spaceName, visitIDHash, currentSeatID, displayName, colorHex, echoCancellationEnabled, agcEnabled, hiFiGainSliderValue, volumeThreshold, } = {}) => {
        let participantToEdit = spaceInformation[spaceName].participants.find((participant) => {
            return participant.visitIDHash === visitIDHash;
        });

        if (participantToEdit) {
            if (typeof (displayName) === "string") {
                participantToEdit.displayName = displayName;
            }
            if (typeof (currentSeatID) === "string") {
                participantToEdit.currentSeatID = currentSeatID;
            }
            if (typeof (colorHex) === "string") {
                participantToEdit.colorHex = colorHex;
            }
            if (typeof (echoCancellationEnabled) === "boolean") {
                participantToEdit.echoCancellationEnabled = echoCancellationEnabled;
            }
            if (typeof (agcEnabled) === "boolean") {
                participantToEdit.agcEnabled = agcEnabled;
            }
            if (typeof (hiFiGainSliderValue) === "string") {
                participantToEdit.hiFiGainSliderValue = hiFiGainSliderValue;
            }
            if (typeof (volumeThreshold) === "number") {
                participantToEdit.volumeThreshold = volumeThreshold;
            }
            socket.to(spaceName).emit("onParticipantsAddedOrEdited", [participantToEdit]);
        } else {
            console.error(`editParticipant: Couldn't get participant with visitIDHash: \`${visitIDHash}\`!`);
        }
    });

    socket.on("disconnect", () => {
        let allSpaces = Object.keys(spaceInformation);

        for (let i = 0; i < allSpaces.length; i++) {
            let currentSpace = spaceInformation[allSpaces[i]];
            let participantToRemove = currentSpace.participants.find((participant) => { return participant.socketID === socket.id; });
            if (participantToRemove) {
                console.log(`${Date.now()}: In ${allSpaces[i]}, removing participant with Hashed Visit ID: \`${participantToRemove.visitIDHash}\`!`);
                currentSpace.participants = currentSpace.participants.filter((participant) => { return participant.socketID !== socket.id; });
            }
        }
    });

    socket.on("requestToEnableEchoCancellation", ({ spaceName, toVisitIDHash, fromVisitIDHash } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToEnableEchoCancellation: Couldn't get participant from \`spaceInformation[${spaceName}].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToEnableEchoCancellation: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToEnableEchoCancellation", { fromVisitIDHash });
    });

    socket.on("requestToDisableEchoCancellation", ({ spaceName, toVisitIDHash, fromVisitIDHash } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToDisableEchoCancellation: Couldn't get participant from \`spaceInformation[spaceName].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToDisableEchoCancellation: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToDisableEchoCancellation", { fromVisitIDHash });
    });

    socket.on("requestToEnableAGC", ({ spaceName, toVisitIDHash, fromVisitIDHash } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToEnableAGC: Couldn't get participant from \`spaceInformation[${spaceName}].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToEnableAGC: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToEnableAGC", { fromVisitIDHash });
    });

    socket.on("requestToDisableAGC", ({ spaceName, toVisitIDHash, fromVisitIDHash } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToDisableAGC: Couldn't get participant from \`spaceInformation[spaceName].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToDisableAGC: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToDisableAGC", { fromVisitIDHash });
    });

    socket.on("requestToChangeHiFiGainSliderValue", ({ spaceName, toVisitIDHash, fromVisitIDHash, newHiFiGainSliderValue } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToChangeHiFiGainSliderValue: Couldn't get participant from \`spaceInformation[spaceName].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToChangeHiFiGainSliderValue: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToChangeHiFiGainSliderValue", { fromVisitIDHash, newHiFiGainSliderValue });
    });

    socket.on("requestToChangeVolumeThreshold", ({ spaceName, toVisitIDHash, fromVisitIDHash, newVolumeThreshold } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToChangeVolumeThreshold: Couldn't get participant from \`spaceInformation[spaceName].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToChangeVolumeThreshold: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToChangeVolumeThreshold", { fromVisitIDHash, newVolumeThreshold });
    });

    socket.on("requestToMuteAudioInputDevice", ({ spaceName, toVisitIDHash, fromVisitIDHash } = {}) => {
        if (!spaceInformation[spaceName]) { return; }
        let participant = spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === toVisitIDHash; });
        if (!participant) {
            console.error(`requestToMuteAudioInputDevice: Couldn't get participant from \`spaceInformation[spaceName].participants[]\` with Visit ID Hash \`${toVisitIDHash}\`!`);
            return;
        }
        if (!participant.socketID) {
            console.error(`requestToMuteAudioInputDevice: Participant didn't have a \`socketID\`!`);
            return;
        }
        socketIOServer.to(participant.socketID).emit("onRequestToMuteAudioInputDevice", { fromVisitIDHash });
    });

    socket.on("addParticle", ({ visitIDHash, spaceName, particleData } = {}) => {
        console.log(`In ${spaceName}, \`${visitIDHash}\` added a particle!.`);
        socket.to(spaceName).emit("requestParticleAdd", { visitIDHash, particleData });
    });

    socket.on("watchPartyUserJoined", (providedUserID, spaceName, roomName) => {
        console.log(`In ${spaceName}/${roomName}, adding watcher with ID \`${providedUserID}\`.`);

        if (!spaceInformation[spaceName][roomName]) {
            spaceInformation[spaceName][roomName] = {
                currentQueuedVideoURL: undefined,
                currentVideoSeekTime: undefined,
                currentPlayerState: undefined,
            };
        }

        if (spaceInformation[spaceName] && spaceInformation[spaceName][roomName] && spaceInformation[spaceName][roomName].currentQueuedVideoURL) {
            onWatchNewVideo(spaceInformation[spaceName][roomName].currentQueuedVideoURL, spaceName, roomName);
        }
    });

    socket.on("enqueueNewVideo", (providedUserID, newVideoURL, spaceName, roomName) => {
        if (!spaceInformation[spaceName]) {
            return;
        }

        if (!spaceInformation[spaceName][roomName]) {
            return;
        }

        spaceInformation[spaceName][roomName].currentVideoSeekTime = 0;

        console.log(`In ${spaceName}/${roomName}, \`${providedUserID}\` requested that a new video be played with URL \`${newVideoURL}\`.`);
        
        onWatchNewVideo(newVideoURL, spaceName, roomName);
    });

    socket.on("requestVideoSeek", (providedUserID, seekTimeSeconds, spaceName, roomName) => {
        if (!spaceInformation[spaceName][roomName]) {
            return;
        }

        spaceInformation[spaceName][roomName].currentVideoSeekTime = seekTimeSeconds;

        console.log(`In ${spaceName}/${roomName}, \`${providedUserID}\` requested that the video be seeked to ${spaceInformation[spaceName][roomName].currentVideoSeekTime}s.`);

        socketIOServer.sockets.in(spaceName).emit("videoSeek", roomName, providedUserID, spaceInformation[spaceName][roomName].currentVideoSeekTime);
    });

    socket.on("setSeekTime", (providedUserID, seekTimeSeconds, spaceName, roomName) => {
        if (!spaceInformation[spaceName][roomName]) {
            return;
        }

        spaceInformation[spaceName][roomName].currentVideoSeekTime = seekTimeSeconds;
    });

    socket.on("newPlayerState", (providedUserID, newPlayerState, seekTimeSeconds, spaceName, roomName) => {
        if (!spaceInformation[spaceName][roomName]) {
            return;
        }

        if (!(newPlayerState === 1 || newPlayerState === 2) || spaceInformation[spaceName].currentPlayerState === newPlayerState) {
            return;
        }

        if (newPlayerState === 2) { // YT.PlayerState.PAUSED
            console.log(`In ${spaceName}/${roomName}, \`${providedUserID}\` requested that the video be paused at ${seekTimeSeconds}s.`);
            socket.broadcast.to(spaceName).emit("videoPause", roomName, providedUserID, seekTimeSeconds);
        } else if (newPlayerState === 1) { // YT.PlayerState.PLAYING
            console.log(`In ${spaceName}/${roomName}, \`${providedUserID}\` requested that the video be played starting at ${seekTimeSeconds}s.`);
            socket.broadcast.to(spaceName).emit("videoPlay", roomName, providedUserID, seekTimeSeconds);
        }

        spaceInformation[spaceName].currentPlayerState = newPlayerState;
    });

    socket.on("stopVideo", (providedUserID, spaceName, roomName) => {
        if (!spaceInformation[spaceName][roomName]) {
            return;
        }

        spaceInformation[spaceName][roomName].currentVideoSeekTime = undefined;
        spaceInformation[spaceName][roomName].currentQueuedVideoURL = undefined;
        console.log(`In ${spaceName}/${roomName}, \`${providedUserID}\` requested that the video be stopped.`);
        socketIOServer.sockets.in(spaceName).emit("stopVideoRequested", roomName, providedUserID);
    });
});

http.listen(PORT, (err) => {
    if (err) {
        throw err;
    }
    console.log(`${Date.now()}: Spatial Audio Rooms is ready. Go to this URL in your browser: http://localhost:${PORT}/spatial-audio-rooms`);
});
