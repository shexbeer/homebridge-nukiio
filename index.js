var nuki = require('./nukibridge');
var Service, Characteristic;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerPlatform("homebridge-nukiio", "NukiBridge", NukiBridgePlatform);
    homebridge.registerAccessory("homebridge-nukiio", "NukiLock", NukiLockAccessory);
};

var CONTEXT_FROM_NUKI_BACKGROUND = "fromNukiBackground";

function NukiBridgePlatform(log, config){
    this.log = log;
    this.nukiBridge = new nuki.NukiBridge(
        this.log, 
        config["bridge_url"], 
        config["api_token"], 
        config["request_timeout_lockstate"],
        config["request_timeout_lockaction"], 
        config["cache_directory"], 
        config["lock_state_mode"], 
        config["webhook_server_ip_or_name"], 
        config["webhook_port"]
    );
    this.locks = config["locks"] || [];
}

NukiBridgePlatform.prototype = {

    accessories: function(callback) {
        var accessories = [];
        for(var i = 0; i < this.locks.length; i++){
            var lock = new NukiLockAccessory(this.log, this.locks[i], this.nukiBridge);
            accessories.push(lock);
        }
        var accessoriesCount = accessories.length;
        
        callback(accessories);
    }
}

function NukiLockAccessory(log, config, nukiBridge) {
    this.log = log;
    this.id = config["id"];
    this.name = config["name"];
    this.nukiBridge = nukiBridge;
    
    this.informationService = new Service.AccessoryInformation();
    this.informationService
        .setCharacteristic(Characteristic.Manufacturer, "Nuki")
        .setCharacteristic(Characteristic.Model, "Nuki Lock")
        .setCharacteristic(Characteristic.SerialNumber, "NukiId "+this.id);
    
    this.lockService = new Service.LockMechanism(this.name);
    this.lockService
        .getCharacteristic(Characteristic.LockCurrentState)
        .on('get', this.getState.bind(this));
    this.lockService
        .getCharacteristic(Characteristic.LockTargetState)
        .on('get', this.getState.bind(this))
        .on('set', this.setState.bind(this));

    this.battservice = new Service.BatteryService(this.name);
    this.battservice
        .getCharacteristic(Characteristic.BatteryLevel)
        .on('get', this.getBattery.bind(this));
    this.battservice
        .getCharacteristic(Characteristic.ChargingState)
        .on('get', this.getCharging.bind(this));
    this.battservice
        .getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', this.getLowBatt.bind(this));
        
    var webHookCallback = (function(isLocked, batteryCritical) {
        var newHomeKitStateLocked = isLocked ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED;
        var newHomeKitStateLockedCurrent = isLocked ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
        var newHomeKitStateBatteryCritical = batteryCritical ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        this.lockService.getCharacteristic(Characteristic.LockCurrentState).setValue(newHomeKitStateLockedCurrent, undefined, CONTEXT_FROM_NUKI_BACKGROUND);
        this.lockService.getCharacteristic(Characteristic.LockTargetState).setValue(newHomeKitStateLocked, undefined, CONTEXT_FROM_NUKI_BACKGROUND); 
        this.battservice.getCharacteristic(Characteristic.StatusLowBattery).setValue(newHomeKitStateBatteryCritical, undefined, CONTEXT_FROM_NUKI_BACKGROUND);
        this.log("HomeKit state change by webhook complete. New isLocked = '%s' and batteryCritical = '%s'.", isLocked, batteryCritical);
    }).bind(this);
    this.nukiLock = new nuki.NukiLock(this.log, nukiBridge, this.id, config["lock_action"], config["unlock_action"], config["priority"], webHookCallback);
};

NukiLockAccessory.prototype.getState = function(callback) {
    this.log("Getting current state...");
    this.nukiLock.isLocked(callback);
};
  
NukiLockAccessory.prototype.setState = function(homeKitState, callback, context) {
    var doLock = homeKitState == Characteristic.LockTargetState.SECURED;
    var newHomeKitState = doLock ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
    if(this.nukiLock.isDoorLatch() && doLock) {
        this.lockService.setCharacteristic(Characteristic.LockCurrentState, newHomeKitState);
        callback(null);
    }
    else {   
        var lockStateChangeCallback = (function(err, json){
            if(err) {
                this.log("An error occured processing lock action. Reason: %s", err);
                callback(err);
            }
            else {
                this.lockService.setCharacteristic(Characteristic.LockCurrentState, newHomeKitState);
                
                if(this.nukiLock.isDoorLatch() && !doLock) {
                    setTimeout((function(){
                        this.lockService.getCharacteristic(Characteristic.LockTargetState).setValue(Characteristic.LockTargetState.SECURED, undefined, CONTEXT_FROM_NUKI_BACKGROUND);
                        this.log("HomeKit change for door latch back to locked state complete.");
                    }).bind(this), 1000);
                }
                
                callback(null);
                this.log("HomeKit state change complete.");
            }
        }).bind(this);
        
        if(context === CONTEXT_FROM_NUKI_BACKGROUND) {
            this.lockService.setCharacteristic(Characteristic.LockCurrentState, newHomeKitState);
            this.log("HomeKit state change complete from Background.");
        }
        else {
            if(doLock) {
                this.nukiLock.lock(lockStateChangeCallback);
            }
            else {
                this.nukiLock.unlock(lockStateChangeCallback);
            }
        }
    }
};

NukiLockAccessory.prototype.getBattery = function(callback) {
    callback(null, 100);
};

NukiLockAccessory.prototype.getCharging = function(callback) {
    callback(null, Characteristic.ChargingState.NOT_CHARGEABLE);
};

NukiLockAccessory.prototype.getLowBatt = function(callback) {
    var getLowBattCallback = (function(err, lowBattery){
        if(err) {
            this.log("An error occured retrieving battery status. Reason: %s", err);
            callback(err);
        }
        else {
            callback(null, lowBattery ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        }
    }).bind(this);
    this.nukiLock.getLowBatt(getLowBattCallback);
};

NukiLockAccessory.prototype.getServices = function() {
  return [this.lockService, this.informationService, this.battservice];
};