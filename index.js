var fs = require('fs');
var CronJobManager = require('cron-job-manager');
var CJmanager = new CronJobManager();
var debug = require('debug');
var request = require('request');
var socket = null;

var modules = [];
var moduleData = {};

var config = null;
var monitorConf = null;
var moduleNames = null;
var monitorClient = null;

// serverType 'monitor' may require database tables
var monitorModuleTables = [];

exports.init = function(conf, db) {
	config = conf;
	moduleNames = config.getModulesToInstall();

	if (config.serverType == 'monitorClient') {
		monitorConf = config.monitor();
		monitorClient = config.monitorClient();

		debug = debug('monitorClient:moduleManager');
	} else {
		debug = debug('monitor:moduleManager');
	}

	for(var i = 0; i < moduleNames.length; i++) {
		var moduleName = moduleNames[i];
		var exists = fs.existsSync('./node_modules/' + moduleName + '/index.js');

		if(exists) {
			var module = require('../' + moduleName);

			if(module.isMonitoringModule) {
				debug('Initialising module: ' + moduleName);
				module.name = moduleName;
				module.config = config.getModuleConfig(moduleName);
				module.monitorClient = monitorClient;

				if(module.init)
					module.init(db);

				if (config.serverType == 'monitor' && module.tables)
					monitorModuleTables = monitorModuleTables.concat(module.tables);

				modules.push(module);
			}
		}
	}
}

exports.getMonitorModuleTables = function(){
	return monitorModuleTables
}

function getModuleByName(moduleName){
	for(var i = 0; i < modules.length; i++) {
		if (modules[i].name == moduleName) {
			return modules[i];
			break;
		}
	}

	return false;
}

exports.registerSockets = function (socketIO) {
	socket = socketIO;

	socket.on('moduleManager', function(data, callback){
		// Get right module
		var monitorModule = getModuleByName(data.moduleName);
		
		if (monitorModule) {
			// Execute right function with parameters
			if (typeof monitorModule[data.params.command] == 'function'){ 
				monitorModule[data.params.command](data, function(data){

					// Send callback back through socketIO
					callback(data);
				});
			}
		}       
	});
};

exports.registerRoutes = function (app)
{
	for(var i = 0; i < modules.length; i++) {
		var monitorModule = modules[i];

		// =================================================================
		// Routes        ===================================================
		// =================================================================
		if(monitorModule.getRoutes) {
			var routes = monitorModule.getRoutes();
			debug('Asking ' + monitorModule.name + ' for routes. Found: ' + routes.length + ' routes');

			for(var j = 0; j < routes.length; j++) {
				var route = routes[j];
				var method = route.method.toLowerCase();

				if(['get','put','delete','post'].indexOf(method) == -1) {
					throw 'Invalid route method: ' + method;
				}

				app[method](route.pattern, route.function);
			}
		}

	}
}

var postModuleDataCallback = function(callback) {
	var moduleDataString = JSON.stringify(moduleData);

	if(moduleDataString != '{}') {

		if (config.serverType == "monitorClient") {
			// Send moduleData through POST HTTP request to monitor

			request({
				method: 'POST',
				url: monitorConf.moduleDataUrl,
				form: {
					moduledata: moduleDataString
				},
				headers: { 
					clienttoken: monitorClient.token
				}
			},
			function (err, response, data) {
				if (!err && response.statusCode == 200) {

					data = JSON.parse(data);
					keys = data.data;
					
					// Delete keys in 'moduleData' object which already sent to / processed in Monitor
					deleteModuleDataKeys(keys);
				}
				else {
					debug('Can\'t reach the Monitor!!');
					
					// Is the monitor accessible after a time to be unattainable?
					// Is the statusCode 413? Monitor can't handle the amount of data. Remove all moduleData in 'moduleData'.
					if(response && response.statusCode == 413) {
						debug('Received statusCode 413. Monitor can\'t handle the amount of data. Remove all moduleData in \'moduleData\'.')
						moduleData = {};
					}
				}
			});

		} else {
			// serverType == monitor -> directly save moduleData
			callback(moduleData, function(keys){
				deleteModuleDataKeys(keys);
			});
		}

	}
}

// Delete keys in 'moduleData' object which already sent to / processed in Monitor
function deleteModuleDataKeys(keys) {
	for (key of keys) {
		delete moduleData[key];
	}
};

// Send all data in 'moduleData' object to the Monitor. afterward delete sent data in 'moduleData'
exports.postModuleData = function(callback) {

	var cronTime = '* */1 * * * * *'; // Every second

	CJmanager.add(
		'postModuleDataToMonitor',
		cronTime,
		function() { postModuleDataCallback(callback); },
		{
			start: true
			//timeZone: "Europe/Amsterdam"
		}
	);

}

var executeCronCallBack = function(monitorModule) {
	return function(error) {
		monitorModule.executeCron(function(err, callbackData){
			if(err)
				debug(err);
			else {
				debug(monitorModule.name, ' cron executed on: ', Date.now());
				
				data = {
					moduleName: monitorModule.name, 
					date: Date.now()
				}

				// Add 'monitorClientId' and 'data' to data object for servertype 'monitorClient' moduleData
				// data from modules in serverType 'monitor' will already give an object with predefined 'monitorClientId' and 'data'
				if( ! callbackData.monitorClientId) {
					data.monitorClientId = monitorClient.id;
					data.data = callbackData;
				} else {
					data.monitorClientId = callbackData.monitorClientId;
					data.data = callbackData.data;
				}

				if(monitorModule.snapshotData)
					data.snapshotData = monitorModule.snapshotData;

				// Put data in 'moduleData' object with an random string as key
				var randomString = Math.random().toString(36).substring(7);
				moduleData[randomString] = data;
			}
		});
	};
}

exports.registerCronjobs = function ()
{
	for(var i = 0; i < modules.length; i++) {
		var monitorModule = modules[i];

		if(monitorModule.hasCron) {
			// Register the function 'monitorModule.executeCron' as a cron job
			debug('Registering ' + monitorModule.name + ' as cronjob.');

			var cronTime = monitorModule.config.cronTime || '* * */1 * * * *';

			CJmanager.add(
				monitorModule.name,
				cronTime,
				executeCronCallBack(monitorModule),
				{
					start: true
					//timeZone: "Europe/Amsterdam"
				}
			);
		}
	}

	debug("I got the current jobs: " + CJmanager.listCrons());
}