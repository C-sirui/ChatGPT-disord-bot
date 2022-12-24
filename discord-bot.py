from typing import Optional
import time
import discord
import json
from discord import app_commands
from chatgpt import Conversation


with open('config.json', 'r') as JSON:
    ## initilize api and conversation histroy with prompt
    config = json.load(JSON)
    botToken = config["discord_bot_token"]
    guild_id = config["channel_id"]
    prompt = config["prompt"]

MY_GUILD = discord.Object(guild_id)  # replace with your guild id (the channel id)

class MyClient(discord.Client):
    def __init__(self, *, intents: discord.Intents):
        super().__init__(intents=intents)
        # A CommandTree is a special type that holds all the application command
        # state required to make it work. This is a separate class because it
        # allows all the extra state to be opt-in.
        # Whenever you want to work with application commands, your tree is used
        # to store and work with them.
        # Note: When using commands.Bot instead of discord.Client, the bot will
        # maintain its own tree instead.
        self.tree = app_commands.CommandTree(self)
        self.activity = discord.Activity(type=discord.ActivityType.watching, name="chatGPT Connected")

    # # In this basic example, we just synchronize the app commands to one guild.
    # # Instead of specifying a guild to every command, we copy over our global commands instead.
    # # By doing so, we don't have to wait up to an hour until they are shown to the end-user.
    async def setup_hook(self):
        # This copies the global commands over to your guild.
        self.tree.copy_global_to(guild=MY_GUILD)
        await self.tree.sync(guild=MY_GUILD)


intents = discord.Intents.default()
client = MyClient(intents=intents)

# manage a user and its chatGPT bot
botUserPair = {}
#
isPrivate = False


@client.event
async def on_ready():
    print(f'Logged in as {client.user} (ID: {client.user.id})')
    print('------')

@client.tree.command()
async def reset(interaction: discord.Interaction):
    """ make your chat private"""
    await interaction.response.defer(ephemeral=True)
    global isPrivate
    try:
        username = str(interaction.user) + "private" if isPrivate else str(interaction.user)
        bot = botUserPair.get(username)
        if bot is not None:
            bot.history = prompt
            await interaction.followup.send(f"Reset successful for your bot")
            return
   
        await interaction.followup.send(f"You haven't created one yet, use /chat to create one")
    except Exception as e:
        await interaction.followup.send(f"unable to reset because of\n{e}")

@client.tree.command()
async def private(interaction: discord.Interaction):
    """ make your chat private"""
    await interaction.response.defer(ephemeral=True)
    global isPrivate
    try:
        if isPrivate:
            await interaction.followup.send(f"Already private")
        else:
            isPrivate = not isPrivate
            await interaction.followup.send(f"Changed to private, if you never chat in private mode before, a new private bot will be created for you")
    except Exception as e:
        await interaction.followup.send(f"unable to turn private chat because of\n{e}")

@client.tree.command()
async def public(interaction: discord.Interaction):
    """ make your chat public"""
    await interaction.response.defer(ephemeral=True)
    global isPrivate
    try:
        if not isPrivate:
            await interaction.followup.send(f"Already public")
        else:
            isPrivate = not isPrivate
            await interaction.followup.send(f"Changed to public, if you never chat in public mode before, a new private bot will be created for you")
    except Exception as e:
        await interaction.response.defer(ephemeral=True)
        await interaction.followup.send(f"unable to turn public chat because of\n{e}")

@client.tree.command()
@app_commands.describe(
    mes='Hi, ChatGPT.',
)
async def chat(interaction: discord.Interaction, mes: str):
    """Say it to ChatGPT"""
    try:
        # confirm interaction, waiting for further reponse
        await interaction.response.defer(ephemeral=isPrivate)

        #check if bot exist for usr, if not then add it to botUserPair
        username = str(interaction.user) + "private" if isPrivate else str(interaction.user)
        if botUserPair.get(username) is not None:
            pass
        else:
            temp = Conversation(prompt)
            botUserPair[username] = temp
            
            #log creation
            t = time.localtime()
            current_time = time.strftime("%Y\%m\%d, %H:%M:%S", t)
            temp.log(f"conversation started at {current_time}\n")

        #get the user's bot
        bot = botUserPair.get(username)

        #get response
        res = bot.chat(mes)

        #log it
        bot.log(f"{username} asked: {mes}\n")
        bot.log(f"bot.{bot.id} replied: {res}\n\n")

        #send it to discord
        returnMes = f"{username} asked: {mes}\nbot replied: {res}"
        await interaction.followup.send(returnMes)
    except Exception as e:
        print("cannot send message")
        await interaction.response.defer(ephemeral=True)
        await interaction.followup.send(f"unable to respound because of\n{e}")
        await interaction.response.defer(ephemeral=False)

client.run(botToken)
