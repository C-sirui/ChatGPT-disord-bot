import openai
import json
import os
import time

botIndex = 0

class Conversation:
    def __init__(self, prompt):
        # set up openai key
        self.config = self.get_config()
        self.openAI_key = self.config['openAI_key']

        # id for the bot
        global botIndex
        self.id = botIndex
        botIndex += 1

        # bot settings
        self.history = prompt # start promot for the bot
        self.temperature = 0.9
        self.max_tokens = 2048
        self.top_p = 1
        self.frequency_penalty = 0.0
        self.presence_penalty = 0.6
   

        ## test if api key is valid 
        openai.api_key = self.openAI_key
        try:
            response = openai.Completion.create(
                model="text-davinci-003",
                prompt=self.history,
                temperature=0.9,
                max_tokens=150,
                top_p=1,
                frequency_penalty=0.0,
                presence_penalty=0.6,
                stop=[" Human:", " AI:"]
            )
        except:
            print(f"Check your api: {self.openAI_key}")
        else:
            print(f"Connection Ok")

    def chat(self, mes):
        self.history += f"\nHuman: {mes}"
        response = openai.Completion.create(
            model="text-davinci-003",
            prompt=self.history,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            top_p=self.top_p,
            frequency_penalty=self.frequency_penalty,
            presence_penalty=self.presence_penalty,
            stop=[" Human:", " AI:"]
        )
        res = response.choices[0].text
        res = res.strip()
        self.history += f"\nAI: {res}"
        return res

    def log(self, mes):
        with open("log.txt", "a") as f:
            f.write(mes)

    def get_config(self):
        with open('config.json', 'r') as JSON:
            json_dict = json.load(JSON)
            return json_dict


        
    
# a = Conversation("The following is a conversation with an AI assistant. The assistant is helpful, creative, clever, and very friendly.")
# while True:
#     mes = input("Human: ")
#     a.chat(mes)


# def start_conversation(intial_prompt):mk;
#     history = f"{intial_prompt}"
#     while True:
#         mes = input("Human: ")
#         history += f"\nHuman: {mes}"
#         response = openai.Completion.create(
#             model="text-davinci-003",
#             prompt=history,
#             temperature=0.9,
#             max_tokens=150,
#             top_p=1,
#             frequency_penalty=0.0,
#             presence_penalty=0.6,
#             stop=[" Human:", " AI:"]
#         )
#         res = response.choices[0].text
#         res = res.strip()
#         history += f"\nAI: {res}"
#         print(
#             f"***\n{response.choices[0].text}\n***"
#         )
# start_conversation("The following is a conversation with an AI assistant. The assistant is helpful, creative, clever, and very friendly.")




