# ChatGPT-disord-bot

> **Warning**
> #### Due to the CloudFlare issue, the bot is using davinci-3 (the chatgpt api) to function.
> #### Also since it remembers all history in one execution, so it will consume more tokens.
> openai==0.25.0, discord.py==2.1.0

# Features

* `/chat [message]` Start chat. It will create a bot only listening to you, and remeber chat history.
* `/private` Bot will reply privately
* `/public`  Bot will reply publically
* Bots in private and public mode are different bots.

# Setup

## Create a bot

1. Change `config.dev.json` to `config.json`
2. Create an application at [here](https://discord.com/developers/applications) and [create a bot](https://discordpy.readthedocs.io/en/stable/discord.html) to your server with read and send message permissions.
3. Copy bot token to `discord_bot_token` in config.json

## Create an openai api

1. Create an [openai api](https://beta.openai.com/account/api-keys) by `Create new secret key` button.
2. Copy secret key to `openAI_key` in config.json

## Run the bot from desktop

1. Copy [channal id](https://turbofuture.com/internet/Discord-Channel-ID) to config.json
2. run "python discord-bot.py" in cmd





