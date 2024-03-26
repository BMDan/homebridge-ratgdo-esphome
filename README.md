<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

<span align="center">

# Homebridge Plugin for RatGDO running ESPHome

</span>

RatGDO is an interface to garage door openers from Liftmaster, Chamberlain, and others.  Unlike many other garage door IoT interfaces, RatGDO requires no cloud connection, and it speaks the wireline protocol, allowing it to expose more features, like motion sensor status, than other hardware can.

This plugin enables the use of a RatGDO running ESPHome with Homebridge (and derivatives like HOOBS).  It supports opening and closing the garage door, and tracks the garage door status (e.g. allowing you to receive notifications if the door is opened or closed by someone hitting the physical button).  It also publishes the following additional data into Home:

* Obstruction Sensor
* RatGDO Firmware Version
* Radio Remote Lockout Status (not displayed in the Home app; it's visible in other apps, like Controller for Homekit)

It *could*, but does not currently, support:

* Motion sensor status
* Light status
* Light control
* Radio remote lockout control
* Opening/Closing duration
* Fine-grained door position
* Radio remote rolling code offset

If you are interested in any of these, all you would need to do is add code to parse their message type in `platformAccessory.ts`; the plumbing is all there already.

### Configuration

First, install ESPHome onto your RatGDO using [this page](https://ratgdo.github.io/esphome-ratgdo/).

Once you've installed this plugin into Homebridge, configuration is very, very straightforward; just use the GUI.  If, for whatever reason, you don't want to do so, all you need to supply is a name, port, and host, like so:

```json
{
    "platform": "RatGDOESPHome",
    "devices": [
        {
            "displayName": "West Garage Door",
            "port": 80,
            "host": "10.0.1.17"
        },
        {
            "displayName": "East Garage Door",
            "port": 80,
            "host": "10.0.1.38"
        }
    ]
}
```

### Implementation

ESPHome exposes a [real-time event source API](https://esphome.io/web-api/index.html?highlight=events#event-source-api) as `/events`.  This allows us to stay in strict lockstep with reality with no lag.  We then cache the most recent status we've received for each element, enabling instantaneous replies to any inquiry.  However, we do so with appropriate caution; uninitialized states are fully differentiated, and the most critical information is actually loaded in a two-step process, whereby we don't actually even register the device in Homebridge until we've received e.g. the serial number of the device.

### Legal

\* Liftmaster, Chamberlain, and other terms used on this page may be names or trademarks of one or more entities.  No endorsement of nor involvement in this project is expressed nor implied by any usage of their names or marks in this document.
