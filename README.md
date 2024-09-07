# Homebridge Sleepme
## Homebridge Plugin for Sleepme Devices

This [Homebridge](https://homebridge.io/) plugin brings [Sleepme](https://sleep.me/) devices like the Dock Pro into the Apple Home app, allowing you to control them via Siri or Home Automations.

This is not an official Sleepme or Apple product, and may stop working without prior notice. Use at your own risk. There are no support guarantees.

### Features

* Control multiple Sleepme devices from Apple Home - turn off your partner's device without borrowing their phone!
* Get low water level warnings in Home app

## Setup

### Before you start

These instructions assume you're already using Homebridge.
For instructions on setting up Homebridge, start at the [Homebridge project homepage](https://homebridge.io/)

### 1. Install the Homebridge Sleepme plugin

Install the Homebridge Sleepme Plugin. We recommend using the Homebridge Config UI. Navigate to the "plugins" tab, and search for "sleepme", then install the plugin.

### 2. Create Sleepme API token 
This plugin uses a Sleepme API token to communicate with Sleepme's servers, send commands, and check the status of your Sleepme devices.

Create a developer API token following the instructions at: https://docs.developer.sleep.me/docs/

If you have multiple user accounts with multiple devices, you can create an API token for each. You can also add multiple devices to a single Sleepme account, which 

### 3. Configure the Homebridge Sleepme plugin 

Add the API token you just created to the Sleepme plugin configuration. Save the configuration, and follow the instructions to restart Homebridge. Within a few minutes, the plugin should discover your Sleepme devices and they should be available in Homebridge and in your Home app. 

## Troubleshooting

This plugin is known to work with the Dock Pro, and has not been tested with other Sleepme devices.

If something isn't working as you expect, please create an Issue on this repository.