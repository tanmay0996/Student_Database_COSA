// routes/events.js
const mongoose = require("mongoose");

const express = require("express");
const router = express.Router();
const { Event, User, OrganizationalUnit } = require("../models/schema");
const { v4: uuidv4 } = require("uuid");
const isAuthenticated = require("../middlewares/isAuthenticated");
const authorizeRole = require("../middlewares/authorizeRole");
const { ROLE_GROUPS } = require("../utils/roles");

// Create a new event (new events can be created by admins only)
router.post(
  "/create",
  isAuthenticated,
  authorizeRole(ROLE_GROUPS.ADMIN),
  async (req, res) => {
    try {
      const {
        title,
        description,
        category,
        type,
        organizing_unit_id,
        organizers,
        schedule,
        registration,
        budget,
      } = req.body;

      // Validate organizing unit
      const orgUnit = await OrganizationalUnit.findById(organizing_unit_id);
      if (!orgUnit) {
        return res
          .status(400)
          .json({ message: "Invalid organizational unit." });
      }

      // Optional: Validate organizer IDs
      if (organizers && organizers.length > 0) {
        const validUsers = await User.find({ _id: { $in: organizers } });
        if (validUsers.length !== organizers.length) {
          return res
            .status(400)
            .json({ message: "One or more organizers are invalid." });
        }
      }

      const newEvent = new Event({
        event_id: uuidv4(),
        title,
        description,
        category,
        type,
        organizing_unit_id,
        organizers,
        schedule,
        registration,
        budget,
      });

      await newEvent.save();
      res
        .status(201)
        .json({ message: "Event created successfully", event: newEvent });
      console.log("Event created:", newEvent);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error while creating event." });
    }
  },
);

// GET all events (for all users: logged in or not logged in)
router.get("/events", async (req, res) => {
  try {
    const events = await Event.find().populate("organizing_unit_id", "name");
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching events." });
  }
});

router.get("/units", isAuthenticated, async (req, res) => {
  try {
    const units = await OrganizationalUnit.find();
    res.json(units);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching organizational units." });
  }
});

router.get("/users", isAuthenticated, async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching users." });
  }
});

// GET event by ID
router.get("/:id", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate("organizing_unit_id", "name")
      .populate("organizers", "personal_info.name");
    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching event." });
  }
});

// POST /:eventId/register
router.post("/:eventId/register", isAuthenticated, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user && req.user._id;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required." });
    }

    // ✅ Validate eventId format
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: "Invalid event ID." });
    }

    const now = new Date();

    // ✅ Build atomic filter
    const filter = {
      _id: mongoose.Types.ObjectId(eventId),
      participants: { $ne: mongoose.Types.ObjectId(userId) },
      $and: [
        {
          $or: [
            { "registration.start": { $exists: false } },
            { "registration.start": { $lte: now } },
          ],
        },
        {
          $or: [
            { "registration.end": { $exists: false } },
            { "registration.end": { $gte: now } },
          ],
        },
        {
          $or: [
            { "registration.max_participants": { $exists: false } },
            {
              $expr: {
                $lt: ["$participants_count", "$registration.max_participants"],
              },
            },
          ],
        },
      ],
    };

    // ✅ Safe atomic update
    const update = {
      $addToSet: { participants: mongoose.Types.ObjectId(userId) },
      $inc: { participants_count: 1 },
    };

    // ✅ Perform atomic update
    const updatedEvent = await Event.findOneAndUpdate(filter, update, {
      new: true,
    })
      .select("title participants_count participants")
      .lean();

    if (updatedEvent) {
      return res.status(200).json({
        message: "Successfully registered!",
        eventId,
        title: updatedEvent.title,
        participants_count: updatedEvent.participants_count || 0,
      });
    }

    // --- No update; diagnose reason ---
    const fresh = await Event.findById(eventId)
      .select("registration participants participants_count")
      .lean();

    if (!fresh) {
      return res.status(404).json({ message: "Event not found." });
    }

    if (fresh.registration && fresh.registration.required === false) {
      return res
        .status(400)
        .json({ message: "Registration is not required for this event." });
    }

    if (
      Array.isArray(fresh.participants) &&
      fresh.participants.some(function (id) {
        return String(id) === String(userId);
      })
    ) {
      return res
        .status(409)
        .json({ message: "You are already registered for this event." });
    }

    if (
      fresh.registration &&
      fresh.registration.start &&
      fresh.registration.end
    ) {
      const s = new Date(fresh.registration.start);
      const e = new Date(fresh.registration.end);
      if (!(s <= now && now <= e)) {
        return res.status(400).json({ message: "Registration is closed." });
      }
    }

    if (
      fresh.registration &&
      typeof fresh.registration.max_participants === "number" &&
      Number.isFinite(fresh.registration.max_participants) &&
      (fresh.participants_count || 0) >= fresh.registration.max_participants
    ) {
      return res.status(409).json({ message: "Registration is full." });
    }

    return res
      .status(400)
      .json({ message: "Unable to register. Please try again." });
  } catch (err) {
    console.error("Error during registration:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ message: "Invalid event ID format." });
    }
    return res
      .status(500)
      .json({ message: "Server error while registering for event." });
  }
});

router.get("/by-role/:userRole", isAuthenticated, async (req, res) => {
  const userRole = req.params.userRole;
  try {
    let query = {};

    // Build the query based on the user's role
    switch (userRole) {
      case "STUDENT":
        query = { status: { $in: ["planned", "ongoing"] } };
        break;

      case "CLUB_COORDINATOR": {
        const username = req.query.username;
        if (!username) {
          return res
            .status(400)
            .json({ message: "Username is required for Club Coordinator." });
        }
        // 1. Find the organizational unit where the contact email matches the username
        const orgUnit = await OrganizationalUnit.findOne({
          "contact_info.email": username,
        });

        if (!orgUnit) {
          return res.status(404).json({
            message: "No organizational unit found for this coordinator.",
          });
        }
        // 2. Set the query to filter events by the unit's _id
        query = { organizing_unit_id: orgUnit._id };
        break;
      }
      case "GENSEC_SCITECH":
        query = { category: "technical" };
        break;

      case "GENSEC_ACADEMIC":
        query = { category: "academic" };
        break;

      case "GENSEC_CULTURAL":
        query = { category: "cultural" };
        break;

      case "GENSEC_SPORTS":
        query = { category: "sports" };
        break;

      case "PRESIDENT":
        query = {};
        break;

      default:
        query = { status: { $in: ["planned", "ongoing"] } };
        break;
    }

    const events = await Event.find(query)
      .sort({ "schedule.start": 1 })
      .populate("organizing_unit_id")
      .populate("organizers")
      .populate("participants")
      .populate("winners.user")
      .populate("room_requests.reviewed_by");

    res.status(200).json(events);
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ message: "Server error while fetching events" });
  }
});

//room request
router.post(
  "/:eventId/room-requests",
  isAuthenticated,
  authorizeRole([...ROLE_GROUPS.GENSECS, ...ROLE_GROUPS.COORDINATORS]),
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const { date, time, room, description } = req.body;
      if (!date || !time || !room) {
        return res
          .status(400)
          .json({ message: "Date, time, and room are required fields." });
      }
      const event = await Event.findById(eventId);

      if (!event) {
        return res.status(404).json({ message: "Event not found." });
      }
      const newRoomRequest = {
        date,
        time,
        room,
        description: description || "",
      };

      event.room_requests.push(newRoomRequest);
      const updatedEvent = await event.save();
      res.status(201).json(updatedEvent);
    } catch (error) {
      console.error("Error adding room request:", error);
      if (error.name === "CastError") {
        return res.status(400).json({ message: "Invalid event ID format." });
      }
      res
        .status(500)
        .json({ message: "Server error while adding room request." });
    }
  },
);

router.patch(
  "/room-requests/:requestId/status",
  isAuthenticated,
  authorizeRole("PRESIDENT"),
  async (req, res) => {
    const { requestId } = req.params;
    const { status, reviewed_by } = req.body;
    if (!status || !["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({
        message: 'A valid status ("Approved" or "Rejected") is required.',
      });
    }
    try {
      const event = await Event.findOne({ "room_requests._id": requestId });
      if (!event) {
        return res
          .status(404)
          .json({ message: "Request or associated event not found." });
      }
      const request = event.room_requests.id(requestId);
      if (request) {
        request.status = status;
        request.requested_at = new Date();
        request.reviewed_by = reviewed_by;
      }

      const updatedEvent = await event.save();
      res.status(200).json(updatedEvent);
    } catch (error) {
      console.error(`Error updating request status to ${status}:`, error);
      res
        .status(500)
        .json({ message: "Server error while updating request status." });
    }
  },
);
module.exports = router;
