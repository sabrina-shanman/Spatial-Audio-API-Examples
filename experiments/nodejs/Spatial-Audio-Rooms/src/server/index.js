const isInProdMode = process.argv.slice(2)[0] === "prod";

console.warn(`*****\nServer production mode status: ${isInProdMode}\n*****\n`);

const webpack = require('webpack');
const path = require('path');
const express = require('express');

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

app.get('/spatial-audio-rooms', async (req, res, next) => {
    require('./serverRender')(isInProdMode, req, async (err, page) => {
        if (err) {
            return next(err);
        }
        res.send(page);
    });
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
    constructor({ socketID, visitIDHash, displayName, colorHex } = {}) {
        this.socketID = socketID;
        this.visitIDHash = visitIDHash;
        this.displayName = displayName;
        this.colorHex = colorHex;
    }
}

let spaceInformation = {};
socketIOServer.on("connection", (socket) => {
    socket.on("addParticipant", ({ spaceName, visitIDHash, displayName, colorHex, echoCancellationEnabled, agcEnabled, } = {}) => {
        if (!spaceInformation[spaceName]) {
            spaceInformation[spaceName] = new ServerSpaceInfo({ spaceName });
        }

        if (spaceInformation[spaceName].participants.find((participant) => { return participant.visitIDHash === visitIDHash; })) {
            // Already had info about this participant.
            return;
        }

        console.log(`In ${spaceName}, adding participant:\nHashed Visit ID: \`${visitIDHash}\`\nDisplay Name: \`${displayName}\`\nColor: ${colorHex}\n`);

        let me = new Participant({
            socketID: socket.id,
            visitIDHash,
            displayName,
            colorHex,
            echoCancellationEnabled,
            agcEnabled
        });

        spaceInformation[spaceName].participants.push(me);

        socket.join(spaceName);

        socket.to(spaceName).emit("onParticipantAdded", [me]);
        socket.emit("onParticipantAdded", spaceInformation[spaceName].participants.filter((participant) => { return participant.visitIDHash !== visitIDHash; }));
    });

    socket.on("editParticipant", ({ spaceName, visitIDHash, displayName, colorHex, echoCancellationEnabled, agcEnabled, } = {}) => {
        let participantToEdit = spaceInformation[spaceName].participants.find((participant) => {
            return participant.visitIDHash === visitIDHash;
        });

        if (participantToEdit) {
            if (typeof (displayName) === "string") {
                participantToEdit.displayName = displayName;
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
            socket.to(spaceName).emit("onParticipantAdded", [participantToEdit]);
        } else {
            console.error(`editParticipant: Couldn't get participant with visitIDHash: \`${visitIDHash}\`!`);
        }
    });

    socket.on("removeParticipant", ({ spaceName, visitIDHash, } = {}) => {
        if (!spaceInformation[spaceName]) {
            return;
        }

        spaceInformation[spaceName].participants = spaceInformation[spaceName].participants.filter((participant) => { return participant.visitIDHash !== visitIDHash; })
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
        socketIOServer.to(participant.socketID).emit("onRequestToEnableEchoCancellation", fromVisitIDHash);
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
        socketIOServer.to(participant.socketID).emit("onRequestToDisableEchoCancellation", fromVisitIDHash);
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
        socketIOServer.to(participant.socketID).emit("onRequestToEnableAGC", fromVisitIDHash);
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
        socketIOServer.to(participant.socketID).emit("onRequestToDisableAGC", fromVisitIDHash);
    });
});

http.listen(PORT, (err) => {
    if (err) {
        throw err;
    }
    console.log(`Spatial Audio Rooms is ready. Go to this URL in your browser: http://localhost:${PORT}/spatial-audio-rooms`);
});