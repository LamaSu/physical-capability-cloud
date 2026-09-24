"""Fake pylabrobot.resources: Deck, TipRack, Plate and the (de)serializer."""

import json


class ResourceNotFoundError(Exception):
    pass


class _Item:
    def __init__(self, name, parent):
        self.name = name
        self.parent = parent


class TipSpot(_Item):
    def __init__(self, name, parent, has_tip=True):
        super().__init__(name, parent)
        self.has_tip = has_tip


class Well(_Item):
    def __init__(self, name, parent, volume=0.0):
        super().__init__(name, parent)
        self.volume = float(volume)


class Resource:
    deserialize_calls = []

    def __init__(self, name):
        self.name = name

    def serialize(self):
        raise NotImplementedError

    @classmethod
    def deserialize(cls, data, allow_marshal=False):
        Resource.deserialize_calls.append({"allow_marshal": allow_marshal})
        kind = data["type"]
        if kind in ("Deck", "OTDeck"):
            from .opentrons import OTDeck

            deck = OTDeck(data["name"]) if kind == "OTDeck" else Deck(data["name"])
            for child in data.get("children", []):
                deck.assign_child_resource(Resource.deserialize(child, allow_marshal=allow_marshal))
            return deck
        if kind == "TipRack":
            return TipRack(data["name"], data["spots"])
        if kind == "Plate":
            return Plate(data["name"], data["wells"])
        raise ValueError(f"fake deserialize: unknown type {kind!r}")

    @classmethod
    def load_from_json_file(cls, json_file):
        with open(json_file, "r", encoding="utf-8") as f:
            return cls.deserialize(json.load(f))


class TipRack(Resource):
    def __init__(self, name, spots):
        super().__init__(name)
        self.spots = {s: TipSpot(s, self) for s in spots}

    def __getitem__(self, key):
        return self.spots[key]

    def serialize(self):
        return {"type": "TipRack", "name": self.name, "spots": list(self.spots)}


class Plate(Resource):
    def __init__(self, name, wells):
        super().__init__(name)
        self.wells = {w: Well(w, self, v) for w, v in wells.items()}

    def __getitem__(self, key):
        return self.wells[key]

    def serialize(self):
        return {"type": "Plate", "name": self.name, "wells": {k: w.volume for k, w in self.wells.items()}}


class Deck(Resource):
    TYPE = "Deck"

    def __init__(self, name="deck"):
        super().__init__(name)
        self.children = {}

    def assign_child_resource(self, resource):
        self.children[resource.name] = resource

    def get_resource(self, name):
        if name not in self.children:
            raise ResourceNotFoundError(f"Resource '{name}' not found")
        return self.children[name]

    def serialize(self):
        return {"type": self.TYPE, "name": self.name, "children": [c.serialize() for c in self.children.values()]}
