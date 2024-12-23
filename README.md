# Homebridge Sleepme
## Homebridge Plugin for Sleepme Devices

This [Homebridge](https://homebridge.io/) plugin brings [Sleepme](https://sleep.me/) devices like the Dock Pro into the Apple Home app, allowing you to control them via Siri or Home Automations.

This is not an official Sleepme or Apple product, and may stop working without prior notice. Use at your own risk. There are no support guarantees.

### Features

* Control multiple Sleepme devices from Apple Home - turn off your partner's device without borrowing their phone!
* Leverage Apple Home automations to automatically adjust your Sleepme devices based on other inputs like presence, ambient temperature, and more.
* Get low water level warnings in Home app.

![main screen](https://i.imgur.com/B1jF4X2.png) ![leak sensor](https://i.imgur.com/Rkxw1OK.png) ![automation example](https://i.imgur.com/hUdXZ1C.png)

## Setup

### Before you start

These instructions assume you're already using Homebridge.
For instructions on setting up Homebridge, start at the [Homebridge project homepage](https://homebridge.io/)

### 1. Install the Homebridge Sleepme plugin

Install the Homebridge Sleepme Plugin. We recommend using the Homebridge Config UI. Navigate to the "plugins" tab, and search for "sleepme", then install the plugin.

### 2. Create Sleepme API token 
This plugin uses a Sleepme API token to communicate with Sleepme's servers, send commands, and check the status of your Sleepme devices.

Create a developer API token following the instructions at: https://docs.developer.sleep.me/docs/

If you have multiple user accounts with multiple devices, you can create an API token for each. You can also add multiple devices to a single Sleepme account, and all devices will load in with a single API token.

### 3. Configure the Homebridge Sleepme plugin 

Add the API token you just created to the Sleepme plugin configuration. Save the configuration, and follow the instructions to restart Homebridge. Within a few minutes, the plugin should discover your Sleepme devices and they should be available in Homebridge and in your Home app.

### 4. Additional Optional Configuration 

There are additional configuration options that can be set to tailor the plugin to your preference:

* **Low Water Level Alert Type**: _None, battery, leak, or motion_. Select the type of virtual sensor that will be generated to represent the water level of your device. By default, "battery" is used and the water level will be represented as the thermostat device's battery level. Leak sensor or motion sensor may be preferable for purposes of using Apple home automations triggered by "leak detected" or "motion detected".
* **API Polling Interval**: This value represents how many minutes the plugin will wait between each poll of the sleepme API to update the devices' status. This interval is automatically faster/shorter for a period of time after you control the thermostat, so this configuration value is for the slow/idle polling time. By default it's 15 minutes. If you want more frequent updates, lower the number. If you get errors or rate limits, increase the number. Keep in mind the number of API calls made is multiplied by the number of devices you have. If you have two docks, two API calls are made at each interval.

## Automation Examples

* Automatically turn your dock ON at bedtime, but only if you're home.
* Automatically turn your dock ON immediately, if you return home after bedtime.
* Automatically turn your dock OFF in the morning when a presence sensor detects that you've left the bedroom.
* Adjust the temperature of your dock based on the temperature in your bedroom or outside.
* Have Siri remind you to top off the water in your dock once per day if the water level is low.


## Troubleshooting

This plugin is known to work with the Dock Pro, and has not been tested with other Sleepme devices.

If something isn't working as you expect, please create an Issue on this repository.
