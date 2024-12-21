# Homebridge Sleepme
## Homebridge Plugin for Sleepme Devices

This [Homebridge](https://homebridge.io/) plugin brings [Sleepme](https://sleep.me/) devices like the Dock Pro into the Apple Home app, allowing you to control them via Siri or Home Automations.

This is not an official Sleepme or Apple product, and may stop working without prior notice. Use at your own risk. There are no support guarantees.

### Features

* Control multiple Sleepme devices from Apple Home - turn off your partner's device without borrowing their phone!
* Leverage Apple Home automations to automatically adjust your Sleepme devices based on other inputs like presence, ambient temperature, and more.
* Dedicated "high" temperature mode virtual switch.
* Get low water level warnings in Home app.

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
* **Virtual Temperature Boost Switch**: Adds 20 degrees to the target temperature. Homekit thermostats only support target temperatures up to 100F, while the Sleepme Dock supports up to 115. In order to utilize this temperature range of the dock, you can turn on this virtual temperature boost switch to add 20 degrees to whatever temperature you choose. For example, if you want to heat to 110F, you'd turn on the temperature boost switch AND set the thermostat to 90. It will tell the dock to warm to 110. If you turn the switch off, it'll set back to 90. This switch is not enabled by default to prevent confusion. If you understand and want to use it, enable it in the plugin config.
* **API Polling Interval**: This value represents how many minutes the plugin will wait between each poll of the sleepme API to update the devices' status. This interval is automatically faster/shorter for a period of time after you control the thermostat, so this configuration value is for the slow/idle polling time. By default it's 15 minutes. If you want more frequent updates, lower the number. If you get errors or rate limits, increase the number.

## Notes

Turning on the "high" temperature mode switch also turns on the dock. Turning OFF the "high" switch doesn't turn off the dock, it just turns off "high" mode.

The thermostat device's mode is automatically displayed based on the difference between the current and target temperature. If the dock is active and the target temperature is higher than the current temperature, it will show heat mode. If the target temperature is lower than the current temperature, it will show cool mode. This functionality, as well as manually changing "modes" in homekit, do not actually make any difference to the backend/dock and are just for aesthetics.

## Troubleshooting

This plugin is known to work with the Dock Pro, and has not been tested with other Sleepme devices.

If something isn't working as you expect, please create an Issue on this repository.
