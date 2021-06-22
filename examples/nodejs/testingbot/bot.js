"use strict";
const {
    MediaStream,
    nonstandard: { RTCAudioSink }
} = require("wrtc");
import {
    HiFiAudioAPIData,
    Point3D,
    OrientationEuler3D,
    HiFiCommunicator,
    HiFiConstants,
    HiFiConnectionStates
} from "hifi-spatial-audio";
const { SignJWT } = require('jose/dist/node/cjs/jwt/sign');
const { UnsecuredJWT } = require('jose/dist/node/cjs/jwt/unsecured');
const crypto = require("crypto");
import { Mutex } from "async-mutex";

const SineSource = require("./sineSource");
const MediaSource = require("./mediaSource");

const minimumTransmissionPeriodAllowedByAPI = 100; // Should we expose this from the API as an exported constant?

class Bot {
    constructor({x = 0, y = 0, z = 0, rollDegrees = 0, pitchDegrees = 0, yawDegrees = 0, volume = 1,
                 serverShouldSendUserData = true,
                 transmitRateLimitTimeoutMS = HiFiConstants.DEFAULT_TRANSMIT_RATE_LIMIT_TIMEOUT_MS, motor, ...options} = {}) {
        this.communicatorMutex = new Mutex();
        // yargs parses an arg of 1.5 as number, but 0.5 as a string, so deal with it by parsing again here.
        this.position = new Point3D({x: parseFloat(x), y: parseFloat(y), z: parseFloat(z)});
        this.orientation = this.makeEuler({pitchDegrees, yawDegrees, rollDegrees});
        if (motor) {
            let {type, updatePeriodMs = HiFiConstants.DEFAULT_TRANSMIT_RATE_LIMIT_TIMEOUT_MS, ...motorOptions}
                = motor.type ? motor :
                // Default x/z is arbitrary, specific to speakeasy and RandomBoundedMovement,
                // and works best with the default map size (43x43m).
                {type: motor, x: [-20, 20], z: [-20, 20]},
                implementation = require("./" + type);
            transmitRateLimitTimeoutMS = Math.max(HiFiConstants.MIN_TRANSMIT_RATE_LIMIT_TIMEOUT_MS,
                                                  Math.min(updatePeriodMs, transmitRateLimitTimeoutMS));
            let initialPosition = new Point3D(this.position);
            this.motor = new implementation({bot: this, start: initialPosition, updatePeriodMs, ...motorOptions});
        }
        this.transmitRateLimitTimeoutMS = transmitRateLimitTimeoutMS;
        this.serverShouldSendUserData = serverShouldSendUserData;
        Object.assign(this, options, {volume: parseFloat(volume)}); // see above re yargs
        this.initializeSource();
        this._initializeCommunicator();
        // This promise will never resolve, unless someone calls this.resolve().
        this.stopped = new Promise(resolve => this.resolve = resolve);
    }
    _initializeCommunicator() {
        // TODO: Stop using this outside the constructor once HiFiCommunicator is able to be re-used, then we can get rid of some class variables we don't need (this.position, this.orientation, this.transmitRateLimitTimeoutMS, this.serverShouldSendUserData)
        let initialAudioData = new HiFiAudioAPIData({
            position: this.position,
            orientationEuler: this.orientation
        });
        this.communicator = new HiFiCommunicator({
            transmitRateLimitTimeoutMS: this.transmitRateLimitTimeoutMS,
            initialHiFiAudioAPIData: initialAudioData,
            serverShouldSendUserData: this.serverShouldSendUserData
        });
    }
    async updatePosition(position) {
        position = new Point3D(position);
        this.communicatorMutex.runExclusive(async () => {
            this.position = position;
            this.communicator.updateUserDataAndTransmit({position: this.position});
        });
        return position;
    }
    makeEuler(options) {
        return new OrientationEuler3D(options);
    }
    async updateOrientation(orientationEuler) {
        orientationEuler = this.makeEuler(orientationEuler);
        await this.communicatorMutex.runExclusive(async () => {
            this.orientation = orientationEuler;
            this.communicator.updateUserDataAndTransmit({orientationEuler: this.orientation});
        });
        return orientationEuler;
    }
    async updateGain(hiFiGain) {
        await this.communicatorMutex.runExclusive(async () => {
            this.communicator.updateUserDataAndTransmit({hiFiGain: hiFiGain});
        });
        return hiFiGain;
    }
    log(...data) {
        console.log(this.botIndex, ...data);
    }
    static async makeJWT(data, secret = undefined) {
        if (!secret) {
            return new UnsecuredJWT(data).encode();
        }
        return await new SignJWT(data)
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .sign(crypto.createSecretKey(Buffer.from(secret, "utf8")));
    }
    async isConnected() {
        let isConnected;
        await this.communicatorMutex.runExclusive(async () => {
            isConnected = this.isStreaming && this.communicator.getConnectionState() == HiFiConnectionStates.Connected;
        });
        return isConnected;
    }
    startConnectIntervals() {
        this.reconnectInterval && clearInterval(this.reconnectInterval);
        this.disconnectInterval && clearInterval(this.disconnectInterval);
        if (typeof(this.reconnectIntervalSeconds) == "number" && this.reconnectIntervalSeconds >= 0) {
            this.reconnectInterval = setInterval(
                (async () => {
                    if (!(await this.isConnected())) {
                        try {
                            this.connect();
                        } catch (error) {
                            this.log(error.message)
                        }
                    }
                }),
            Math.max(10, this.reconnectIntervalSeconds * 1000));
        }
        if (typeof(this.disconnectIntervalSeconds) == "number" && this.disconnectIntervalSeconds >= 0 && typeof(this.disconnectChance) == "number") {
            this.disconnectInterval = setInterval(
                async () => {
                    if ((await this.isConnected())) {
                        try {
                            if (Math.random() < this.disconnectChance) {
                                this.disconnect();
                            }
                        } catch (error) {
                            this.log(error.message)
                        }
                    }
                },
            Math.max(10, this.disconnectIntervalSeconds * 1000));
        }
    }
    stopConnectIntervals() {
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = undefined;
        }
        if (this.disconnectInterval) {
            clearInterval(this.disconnectInterval);
            this.disconnectInterval = undefined;
        }
    }
    async connect(inputMediaStream = this.source && this.source.srcObject,
                  isStereo = this.source && this.source.numberOfChannels === 2) {
        await this.communicatorMutex.runExclusive(async () => {
            let {
                botIndex = 0,
                name = "Bot #",
                user_id = name.replace('#', botIndex),
                app_id, space_id, secret,
                jwt
            } = this;
            jwt = jwt || await this.constructor.makeJWT({app_id, space_id, user_id}, secret); // jwt could be empty string.
            inputMediaStream && await this.communicator.setInputAudioMediaStream(inputMediaStream, isStereo); // before connection
            let response = await this.communicator.connectToHiFiAudioAPIServer(jwt, this.stackName);
            await this.startSink(); // After connect, because communicator doesn't have an output stream until then.
            let alreadyConnected = false;
            if (response.success) {
                alreadyConnected = response.audionetInitResponse === undefined;
                if (alreadyConnected) {
                    this.log('already connected');
                } else {
                    this.log('connected to server running', response.audionetInitResponse.build_version);
                }
            } else {
                throw new Error(`Connect failure: ${JSON.stringify(response)}`);
            }
            if (!alreadyConnected) {
                this.audioMixerUserID = response.audionetInitResponse.id;
            }
            this.motor && await this.motor.start();

            this.measure && await this.startMeasurement();
            this.isStreaming = true;
        });
    }
    async disconnect() {
        await this.communicatorMutex.runExclusive(async () => {
            this.log('disconnecting');
            this.isStreaming = false;

            let reports = await this.stopMeasurement();
            reports && this.log(`nBytes ${reports.measured.bytesSent} => ${reports.measured.bytesReceived}`);

            this.motor && this.motor.stop();
            this.sink.stop();
            await this.communicator.disconnectFromHiFiAudioAPIServer();
            // TODO: Remove this line once we are able to re-use a HiFiCommunicator object
            this._initializeCommunicator();
            this.log('disconnected');
        });
    }
    async start() {
        this.source && await this.startSource();
        await this.connect();
        this.source && await this.source.play();
        this.runtimeSeconds && setTimeout(() => this.stop(), this.runtimeSeconds * 1000);
        this.startConnectIntervals();
    }
    async stop() {
        this.log('stopping');
        this.stopConnectIntervals();
        await this.disconnect();
        this.source && this.source.pause();
        this.log('finished');
        // Node will normally exit when nothing is left to run. However, wrtc RTCPeerConnection doesn't
        // ever stop once it is instantiated, so node won't end on its own. To work around this,
        // our constructor creates a promise in this.stopped, which will resolve when we
        // call this next line. Callers can explicitly exit when every bot.stopped has resolved.
        this.resolve();
    }
    startSink() {
        let streamOut = this.communicator.getOutputAudioMediaStream();
        // Note: you get the downstream data even if you don't connect a sink.
        // Indeed, even if you go through each track and disable it or stop it.
        return this.sink = new RTCAudioSink(streamOut.getAudioTracks()[0]); // truthy
        // Subclasses might attach something to this.sink.ondata.
        // See https://github.com/node-webrtc/node-webrtc/blob/develop/docs/nonstandard-apis.md#rtcaudiosink and above that.
    }
    initializeSource() {
        let {audio} = this;
        if (!audio) return;
        const frequency = parseInt(audio, 10);
        if (isNaN(frequency)) {
            if (!audio.includes(':')) {
                audio = `file://${__dirname}/audio/${audio}`;
            }
            this.source = new MediaSource({url: audio, bot: this});
        } else {
            this.source = new SineSource({frequency, bot: this});
        }
    }
    async startSource() {
        let {gain = 1} = this;
        await this.updateGain(gain);
        await this.source.load(); // but not play just yet
    }
    async startMeasurement() { // Starts capturing bandiwdth and other reports.
        // Does not require libcap/Npcap unless actually called.
        let peer = this.raviSession._raviImplementation._rtcConnection,
            state = peer && peer.connectionState;
        if (state  !== 'connected') {
            // Not strictly necessary, as someone downstream will get an error, but
            // this way we capture the recognizable application-code stack, and report the state.
            throw new Error(`Bot ${this.botIndex} is in connection state ${state}, and cannot be measured.`);
        }
        let BandwidthMeasurement = require('./bandwidthMeasurement'),
            measurement = new BandwidthMeasurement(peer, this.botIndex,);
        await measurement.start();
        return this.bandwidthMeasurement = measurement;
    }
    async stopMeasurement() {
        let measurement = this.bandwidthMeasurement;
        if (!measurement) return;
        this.bandwidthMeasurement = null;
        let reports = await measurement.stop();
        this.log(reports);
        this.reports = reports;
        return reports;
    }
    static run(options) {
        let bot = new this(options);
        // Applications that use start directly can handle errors how they chose.
        // But for anythign that uses run, we catch and display any asynchronous errors.
        bot.start().catch(error => console.error(bot.botIndex, error));
        return bot;
    }
    get raviSession() {
        let communicator = this.communicator;
        if (!commmunicator) { return undefined; }
        let mixerSession = communicator._mixerSession;
        if (!mixerSession) { return undefined; }
        let raviSession = mixerSession._raviSession;
        return raviSession;
    }
}
module.exports = Bot;

