# ChatGPT-disord-bot

> **Warning**
> Due to the CloudFlare issue, the bot is using davinci-3 (the chatgpt api) to function.
> Also since it remembers all history in one execution, it will consume tokens quicker than usual.

# Features

* `/chat [message]` Start chat. It will create a bot only listening to you.
* `/private` Bot will reply privately
* `/public`  Bot will reply publically
* **Attension**: Bots in private and public mode are different bots.

# Setup

## Fill up settings

1. Change `config.dev.json` to `config.json`
2. Create an application at [here](https://discord.com/developers/applications) and [create a bot](https://discordpy.readthedocs.io/en/stable/discord.html) in it.
3. Add the bot to your channel

