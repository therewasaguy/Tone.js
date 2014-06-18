define(["Tone/core/Tone", "Tone/core/Master", "Tone/signal/Signal"], 
function(Tone){


	/**
	 *  oscillator-based transport allows for simple musical timing
	 *  supports tempo curves and time changes
	 *
	 *  @constructor
	 */
	Tone.Transport = function(){

		/**
		 *  watches the main oscillator for timing ticks
		 *  
		 *  @private
		 *  @type {ScriptProcessorNode}
		 */
		this._jsNode = this.context.createScriptProcessor(this.bufferSize, 1, 1);
		this._jsNode.onaudioprocess = this._processBuffer.bind(this);

		/** @type {boolean} */
		this.loop = false;

		//so it doesn't get garbage collected
		this._jsNode.toMaster();
	};

	Tone.extend(Tone.Transport);

	/** @private @type {number} */
	var transportTicks = 0;
	/** @private @type {number} */
	var tatum = 12;
	/** @private @type {boolean} */
	var upTick = false;
	/** @private @type {number} */
	var transportTimeSignature = 4;

	/** @private @type {number} */
	var loopStart = 0;
	/** @private @type {number} */
	var loopEnd = tatum * 4;

	/** @private @type {Array<TimelineEvent>} */
	var intervals = [];
	/** @private @type {Array<TimelineEvent>} */
	var timeouts = [];
	/** @private @type {Array<TimelineEvent>} */
	var timeline = [];
	/** @private @type {number} */
	var timelineProgress = 0;

	/**
	 *  The main oscillator for the system
	 *  @private
	 *  @type {OscillatorNode}
	 */
	var oscillator = null;

	/** 
	 *  controls the oscillator frequency
	 *  starts at 120bpm
	 *  @private
	 *  @type {Tone.Signal}
	 */
	var controlSignal = new Tone.Signal(120);

	/** 
	 *  All of the synced components
	 *  @private @type {Array<Tone>}
	 */
	var SyncedComponents = [];


	///////////////////////////////////////////////////////////////////////////////
	//	JS NODE PROCESSING
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  called when a buffer is ready
	 *  	
	 *  @param  {AudioProcessingEvent} event
	 */
	Tone.Transport.prototype._processBuffer = function(event){
		var now = this.defaultArg(event.playbackTime, this.now());
		var bufferSize = this._jsNode.bufferSize;
		var incomingBuffer = event.inputBuffer.getChannelData(0);
		for (var i = 0; i < bufferSize; i++){
			var sample = incomingBuffer[i];
			if (sample > 0 && !upTick){
				upTick = true;	
				this._processTick(now + this.samplesToSeconds(i), i);
			} else if (sample < 0 && upTick){
				upTick = false;
			}
		}
	};

	//@param {number} tickTime
	Tone.Transport.prototype._processTick = function(tickTime, i){
		if (oscillator !== null){
			transportTicks += 1;
			processIntervals(tickTime);
			processTimeouts(tickTime, i);
			processTimeline(tickTime);
			if (this.loop){
				if (transportTicks === loopEnd){
					this._setTicks(this.loopEnd);
				}
			}
		}
	};

	//jump to a specific tick in the timeline
	Tone.Transport.prototype._setTicks = function(ticks){
		transportTicks = ticks;
		for (var i = 0; i < timeline.length; i++){
			var timeout = timeline[i];
			if (timeout.callbackTick() >= ticks){
				timelineProgress = i;
				break;
			}
		}
	};

	///////////////////////////////////////////////////////////////////////////////
	//	EVENT PROCESSING
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  process the intervals
	 *  @param  {number} time 
	 */
	var processIntervals = function(time){
		for (var i = 0, len = intervals.length; i<len; i++){
			var interval = intervals[i];
			if (interval.testInterval(transportTicks)){
				interval.doCallback(time);
			}
		}
	};

	/**
	 *  process the timeouts
	 *  @param  {number} time 
	 */
	var processTimeouts = function(time){
		var removeTimeouts = 0;
		for (var i = 0, len = timeouts.length; i<len; i++){
			var timeout = timeouts[i];
			var callbackTick = timeout.callbackTick();
			if (callbackTick <= transportTicks){
				timeout.doCallback(time);
				removeTimeouts++;
			} else if (callbackTick > transportTicks){
				break;
			} 
		}
		//remove the timeouts off the front of the array after they've been called
		timeouts.splice(0, removeTimeouts);
	};

	/**
	 *  process the timeline events
	 *  @param  {number} time 
	 */
	var processTimeline = function(time){
		for (var i = timelineProgress, len = timeline.length; i<len; i++){
			var evnt = timeline[i];
			var callbackTick = evnt.callbackTick();
			if (callbackTick <= transportTicks){
				evnt.doCallback(time);
				timelineProgress = i;
			} else if (callbackTick > transportTicks){
				break;
			} 
		}
	};

	/**
	 *  clear the timeouts and intervals
	 */
	function clearTimelineEvents(){
		timeouts = [];
		intervals = [];
	}

	///////////////////////////////////////////////////////////////////////////////
	//	INTERVAL
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  intervals are recurring events 
	 *  
	 *  @param {function} callback
	 *  @param {Tone.Time}   interval 
	 *  @param {Object}   ctx  the context the function is invoked in
	 *  @return {number} the id of the interval
	 */
	Tone.Transport.prototype.setInterval = function(callback, interval, ctx){
		var tickTime = this.toTicks(interval);
		var timeout = new TimelineEvent(callback, ctx, tickTime, transportTicks);
		intervals.push(timeout);
		return timeout.id;
	};

	/**
	 *  clear an interval from the processing array
	 *  @param  {number} rmInterval 	the interval to remove
	 *  @return {boolean}            	true if the event was removed
	 */
	Tone.Transport.prototype.clearInterval = function(rmInterval){
		for (var i = 0; i < intervals.length; i++){
			var interval = intervals[i];
			if (interval.id === rmInterval){
				intervals.splice(i, 1);
				return true;
			}
		}
		return false;
	};

	///////////////////////////////////////////////////////////////////////////////
	//	TIMEOUT
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  set a timeout to occur after time from now
	 *  
	 *  @param {function} callback 
	 *  @param {Tone.Time}   time     
	 *  @param {Object}   ctx      the context to invoke the callback in
	 *  @return {number} the id of the timeout for clearing timeouts
	 */
	Tone.Transport.prototype.setTimeout = function(callback, time, ctx){
		var ticks = this.toTicks(time);
		var timeout = new TimelineEvent(callback, ctx, ticks + transportTicks, 0);
		//put it in the right spot
		for (var i = 0, len = timeouts.length; i<len; i++){
			var testEvnt = timeouts[i];
			if (testEvnt.callbackTick() > timeout.callbackTick()){
				timeouts.splice(i, 0, timeout);
				return timeout.id;
			}
		}
		//otherwise push it on the end
		timeouts.push(timeout);
		return timeout.id;
	};

	/**
	 *  clear the timeout based on it's ID
	 *  @param  {number} timeoutID 
	 *  @return {boolean}           true if the timeout was removed
	 */
	Tone.Transport.prototype.clearTimeout = function(timeoutID){
		for (var i = 0; i < timeouts.length; i++){
			var testTimeout = timeouts[i];
			if (testTimeout.id === timeoutID){
				timeouts.splice(i, 1);
				return true;
			}
		}
		return false;
	};

	///////////////////////////////////////////////////////////////////////////////
	//	TIMELINE
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  Timeline events are synced to the timeline of the Transport
	 *  Unlike Timeout, Timeline events will restart after the 
	 *  Transport has been stopped and restarted. 
	 *
	 *  
	 *  @param {function} 	callback 	
	 *  @param {Tome.Time}  timeout  
	 *  @param {Object}   	ctx      	the context in which the funtion is called
	 *  @return {number} 				the id for clearing the timeline event
	 */
	Tone.Transport.prototype.setTimeline = function(callback, timeout, ctx){
		var ticks = this.toTicks(timeout);
		ctx = this.defaultArg(ctx, window);
		var timelineEvnt = new TimelineEvent(callback, ctx, ticks + transportTicks, 0);
		//put it in the right spot
		for (var i = timelineProgress, len = timeline.length; i<len; i++){
			var testEvnt = timeline[i];
			if (testEvnt.callbackTick() > timelineEvnt.callbackTick()){
				timeline.splice(i, 0, timelineEvnt);
				return timelineEvnt.id;
			}
		}
		//otherwise push it on the end
		timeline.push(event);
		return timelineEvnt.id;
	};

	/**
	 *  clear the timeline event from the 
	 *  @param  {number} timelineID 
	 *  @return {boolean} true if it was removed
	 */
	Tone.Transport.prototype.clearTimeline = function(timelineID){
		for (var i = 0; i < timeline.length; i++){
			var testTimeline = timeline[i];
			if (testTimeline.id === timelineID){
				timeline.splice(i, 1);
				return true;
			}
		}
		return false;
	};

	///////////////////////////////////////////////////////////////////////////////
	//	TIME CONVERSIONS
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  turns the time into
	 *  @param  {Tone.Time} time
	 *  @return {number}      
	 */
	Tone.Transport.prototype.toTicks = function(time){
		//get the seconds
		var seconds = this.toSeconds(time);
		var quarter = this.notationToSeconds("4n");
		var quarters = seconds / quarter;
		var tickNum = quarters * tatum;
		//quantize to tick value
		return Math.round(tickNum);
	};

	/**
	 *  get the transport time
	 *  @return {string} in transportTime format (measures:beats:sixteenths)
	 */
	Tone.Transport.prototype.getTransportTime = function(){
		var quarters = transportTicks / tatum;
		var measures = Math.floor(quarters / transportTimeSignature);
		var sixteenths = Math.floor((quarters % 1) * 4);
		quarters = Math.floor(quarters) % transportTimeSignature;
		var progress = [measures, quarters, sixteenths];
		return progress.join(":");
	};

	/**
	 *  set the transport time, jump to the position right away
	 *  	
	 *  @param {Tone.Time} progress 
	 */
	Tone.Transport.prototype.setTransportTime = function(progress){
		var ticks = this.toTicks(progress);
		this._setTicks(ticks);
	};

	///////////////////////////////////////////////////////////////////////////////
	//	START/STOP/PAUSE
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  start the transport and all sources synced to the transport
	 *  
	 *  @param  {Tone.Time} time
	 */
	Tone.Transport.prototype.start = function(time){
		if (oscillator === null){
			//reset the oscillator
			oscillator = this.context.createOscillator();
			oscillator.type = "square";
			oscillator.connect(this._jsNode);
			//connect it up
			controlSignal.connect(oscillator.frequency);
			oscillator.frequency.value = 0;
		}
		upTick = false;
		oscillator.start(this.toSeconds(time));
		//call start on each of the synced sources
	};


	/**
	 *  stop the transport and all sources synced to the transport
	 *  
	 *  @param  {Tone.Time} time
	 */
	Tone.Transport.prototype.stop = function(time){
		if (oscillator !== null){
			oscillator.stop(this.toSeconds(time));
			oscillator = null;
		}
		this._setTicks(0);
		clearTimelineEvents();
		//call stop on each of the synced sources
	};

	/**
	 *  pause the transport and all sources synced to the transport
	 *  
	 *  @param  {Tone.Time} time
	 */
	Tone.Transport.prototype.pause = function(time){
		oscillator.stop(this.toSeconds(time));
		oscillator = null;
		clearTimelineEvents();
		//call pause on each of the synced sources
	};

	///////////////////////////////////////////////////////////////////////////////
	//	SETTERS/GETTERS
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  set the BPM
	 *  optionally ramp to the bpm over some time
	 *  @param {number} bpm   
	 *  @param {Tone.Time=} rampTime 
	 */
	Tone.Transport.prototype.setBpm = function(bpm, rampTime){
		//convert the bpm to frequency
		var tatumFreq = this.toFrequency(tatum.toString() + "n", bpm, transportTimeSignature);
		var freqVal = 4 * tatumFreq;
		if (!rampTime){
			controlSignal.cancelScheduledValues(0);
			controlSignal.setValue(freqVal);
		} else {
			controlSignal.exponentialRampToValueNow(freqVal, rampTime);
		}
	};

	/**
	 *  return the current BPM
	 *  
	 *  @return {number} 
	 */
	Tone.Transport.prototype.getBpm = function(){
		//convert the current frequency of the oscillator to bpm
		var freq = controlSignal.getValue();
		return 60 * (freq / tatum);
	};

	/**
	 *  set the time signature
	 *  
	 *  @example
	 *  this.setTimeSignature(4); //for 4/4
	 *  
	 *  @param {number} numerator   
	 *  @param {number=} denominator defaults to 4
	 */
	Tone.Transport.prototype.setTimeSignature = function(numerator, denominator){
		denominator = this.defaultArg(denominator, 4);
		transportTimeSignature = numerator / (denominator / 4);
	};

	/**
	 *  return the time signature as just the numerator
	 *  over 4 is assumed. 
	 *  for example 4/4 would return 4 and 6/8 would return 3
	 *  
	 *  @return {number} 
	 */
	Tone.Transport.prototype.getTimeSignature = function(){
		return transportTimeSignature;
	};

	/**
	 *  set the loop start position
	 *  
	 *  @param {Tone.Time} startPosition
	 */
	Tone.Transport.prototype.setLoopStart = function(startPosition){
		loopStart = this.toTicks(startPosition);
	};

	/**
	 *  set the loop start position
	 *  
	 *  @param {Tone.Time} endPosition
	 */
	Tone.Transport.prototype.setLoopEnd = function(endPosition){
		loopEnd = this.toTicks(endPosition);
	};

	/**
	 *  shorthand loop setting
	 *  @param {Tone.Time} startPosition 
	 *  @param {Tone.Time} endPosition   
	 */
	Tone.Transport.prototype.setLoopPoint = function(startPosition, endPosition){
		this.setLoopStart(startPosition);
		this.setLoopEnd(endPosition);
	};

	///////////////////////////////////////////////////////////////////////////////
	//	SYNCING
	///////////////////////////////////////////////////////////////////////////////
	

	Tone.Transport.prototype.sync = function(source, controlSignal){
		//create a gain node, attach it to the control signal
		// var ratio = new Tone.Multiply();
		// controlSignal.connect(ratio);
		// return ratio;
	};

	/**
	 *  remove the source from the list of Synced Sources
	 *  
	 *  @param  {[type]} source [description]
	 *  @return {[type]}        [description]
	 */
	Tone.Transport.prototype.unsync = function(source){
		
	};


	///////////////////////////////////////////////////////////////////////////////
	//	TIMELINE EVENT
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  @static
	 *  @type {number}
	 */
	var TimelineEventIDCounter = 0;

	/**
	 *  A Timeline event
	 *
	 *  @constructor
	 *  @param {function(number)} callback   
	 *  @param {Object}   context    
	 *  @param {number}   tickTime
 	 *  @param {number}   startTicks
	 */
	var TimelineEvent = function(callback, context, tickTime, startTicks){
		this.startTicks = startTicks;
		this.tickTime = tickTime;
		this.callback = callback;
		this.context = context;
		this.id = TimelineEventIDCounter++;
	};
	
	/**
	 *  invoke the callback in the correct context
	 *  passes in the playback time
	 *  
	 *  @param  {number} playbackTime 
	 */
	TimelineEvent.prototype.doCallback = function(playbackTime){
		this.callback.call(this.context, playbackTime); 
	};

	/**
	 *  get the tick which the callback is supposed to occur on
	 *  
	 *  @return {number} 
	 */
	TimelineEvent.prototype.callbackTick = function(){
		return this.startTicks + this.tickTime;
	};

	/**
	 *  test if the tick occurs on the interval
	 *  
	 *  @param  {number} tick 
	 *  @return {boolean}      
	 */
	TimelineEvent.prototype.testInterval = function(tick){
		return (tick - this.startTicks) % this.tickTime === 0;
	};


	///////////////////////////////////////////////////////////////////////////////
	//	AUGMENT TONE'S PROTOTYPE TO INCLUDE TRANSPORT TIMING
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  tests if a string is musical notation
	 *  i.e.:
	 *  	4n = quarter note
	 *   	2m = two measures
	 *    	8t = eighth-note triplet
	 *  
	 *  @return {boolean} 
	 */
	Tone.prototype.isNotation = (function(){
		var notationFormat = new RegExp(/[0-9]+[mnt]$/i);
		return function(note){
			return notationFormat.test(note);
		};
	})();

	/**
	 *  tests if a string is transportTime
	 *  i.e. :
	 *  	1:2:0 = 1 measure + two quarter notes + 0 sixteenth notes
	 *  	
	 *  @return {boolean} 
	 */
	Tone.prototype.isTransportTime = (function(){
		var transportTimeFormat = new RegExp(/^\d+(\.\d+)?:\d+(\.\d+)?(:\d+(\.\d+)?)?$/);
		return function(transportTime){
			return transportTimeFormat.test(transportTime);
		};
	})();

	/**
	 *  true if the input is in the format number+hz
	 *  i.e.: 10hz
	 *
	 *  @param {number} freq 
	 *  @return {boolean} 
	 */
	Tone.prototype.isFrequency = (function(){
		var freqFormat = new RegExp(/[0-9]+hz$/i);
		return function(freq){
			return freqFormat.test(freq);
		};
	})();


	/**
	 *  convert notation format strings to seconds
	 *  @param  {string} notation     
	 *  @param {number=} bpm 
	 *  @param {number=} timeSignature 
	 *  @return {number}               
	 */
	Tone.prototype.notationToSeconds = function(notation, bpm, timeSignature){
		bpm = this.defaultArg(bpm, Tone.Transport.getBpm());
		timeSignature = this.defaultArg(timeSignature, transportTimeSignature);
		var beatTime = (60 / bpm);
		var subdivision = parseInt(notation, 10);
		var beats = 0;
		if (subdivision === 0){
			beats = 0;
		}
		var lastLetter = notation.slice(-1);
		if (lastLetter === "t"){
			beats = (4 / subdivision) * 2/3;
		} else if (lastLetter === "n"){
			beats = 4 / subdivision;
		} else if (lastLetter === "m"){
			beats = subdivision * timeSignature;
		} else {
			beats = 0;
		}
		return beatTime * beats;
	};

	/**
	 *  convert transportTime into seconds
	 *  i.e.:
	 *  	4:2:3 == 4 measures + 2 quarters + 3 sixteenths
	 *  
	 *  @param  {string} transportTime 
	 *  @param {number=} bpm 
	 *  @param {number=} timeSignature
	 *  @return {number}               seconds
	 */
	Tone.prototype.transportTimeToSeconds = function(transportTime, bpm, timeSignature){
		bpm = this.defaultArg(bpm, Tone.Transport.getBpm());
		timeSignature = this.defaultArg(timeSignature, transportTimeSignature);
		var measures = 0;
		var quarters = 0;
		var sixteenths = 0;
		var split = transportTime.split(":");
		if (split.length === 2){
			measures = parseFloat(split[0]);
			quarters = parseFloat(split[1]);
		} else if (split.length === 1){
			quarters = parseFloat(split[0]);
		} else if (split.length === 3){
			measures = parseFloat(split[0]);
			quarters = parseFloat(split[1]);
			sixteenths = parseFloat(split[2]);
		}
		var beats = (measures * timeSignature + quarters + sixteenths / 4);
		return beats * this.notationToSeconds("4n");
	};

	/**
	 *  Convert seconds to the closest transportTime in the form 
	 *  	measures:quarters:sixteenths
	 *  	
	 *  @param {Tone.Time} seconds 
	 *  @param {number=} bpm 
	 *  @param {number=} timeSignature
	 *  @return {string}         
	 */
	Tone.prototype.toTransportTime = function(time, bpm, timeSignature){
		var seconds = this.toSeconds(time, bpm, timeSignature);
		bpm = this.defaultArg(bpm, Tone.Transport.getBpm());
		timeSignature = this.defaultArg(timeSignature, transportTimeSignature);
		var quarterTime = this.notationToSeconds("4n");
		var quarters = seconds / quarterTime;
		var measures = Math.floor(quarters / timeSignature);
		var sixteenths = Math.floor((quarters % 1) * 4);
		quarters = Math.floor(quarters) % timeSignature;
		var progress = [measures, quarters, sixteenths];
		return progress.join(":");
	};

	/**
	 *  convert a time to a frequency
	 *  	
	 *  @param  {Tone.Time} time 
	 *  @return {number}      the time in hertz
	 */
	Tone.prototype.toFrequency = function(time, bpm, timeSignature){
		if (this.isFrequency(time)){
			return parseFloat(time);
		} else if (this.isNotation(time) || this.isTransportTime(time)) {
			return this.secondsToFrequency(this.toSeconds(time, bpm, timeSignature));
		} else {
			return time;
		}
	};

	/**
	 *  convert Tone.Time into seconds
	 *  
	 *  unlike the method which it overrides, this takes into account 
	 *  transporttime and musical notation
	 *  
	 *  @param  {Tone.Time} time       
	 *  @param  {number=} 	bpm 
	 *  @param  {number=} 	timeSignature   
	 */
	Tone.prototype.toSeconds = function(time, bpm, timeSignature){
		if (typeof time === "number"){
			return time; //assuming that it's seconds
		} else if (typeof time === "string"){
			var plusTime = 0;
			if(time.charAt(0) === "+") {
				plusTime = this.now();
				time = time.slice(1);				
			} 
			if (this.isNotation(time)){
				time = this.notationToSeconds(time, bpm, timeSignature);
			} else if (this.isTransportTime(time)){
				time = this.transportTimeToSeconds(time, bpm, timeSignature);
			} else if (this.isFrequency(time)){
				time = this.frequencyToSeconds(time, bpm, timeSignature);
			} else {
				time = parseFloat(time);
			}
			return time + plusTime;
		} else {
			return this.now();
		}
	};

	//a single transport object
	Tone.Transport = new Tone.Transport();

	return Tone.Transport;
});