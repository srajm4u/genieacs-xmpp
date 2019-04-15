import { exec } from "child_process";
import { ObjectID } from "mongodb";
import * as db from "./db";
import { del } from "../cache";
import { getUsers } from "../local-cache";
import { hashPassword } from "../auth";
import {
  insertTasks,
  watchTask,
  connectionRequest,
  deleteDevice
} from "../api-functions";

async function deleteFault(id): Promise<void> {
  const deviceId = id.split(":", 1)[0];
  const channel = id.slice(deviceId.length + 1);

  await Promise.all([
    db.deleteFault(id),
    channel.startsWith("task_")
      ? db.deleteTask(new ObjectID(channel.slice(5)))
      : null
  ]);

  await del(`${deviceId}_tasks_faults_operations`);
}

export async function deleteResource(resource, id): Promise<void> {
  switch (resource) {
    case "devices":
      await deleteDevice(id);
      break;

    case "files":
      await db.deleteFile(id);
      break;

    case "faults":
      await deleteFault(id);
      break;

    case "provisions":
      await db.deleteProvision(id);
      break;

    case "presets":
      await db.deletePreset(id);
      break;

    case "virtualParameters":
      await db.deleteVirtualParameter(id);
      break;

    case "config":
      await db.deleteConfig(id);
      break;

    case "permissions":
      await db.deletePermission(id);
      break;

    case "users":
      await db.deleteUser(id);
      break;
  }

  await del("presets_hash");
}

export async function postTasks(
  deviceId,
  tasks,
  timeout
): Promise<{ connectionRequest: string; tasks: any[] }> {
  for (const task of tasks) task.device = deviceId;

  tasks = await insertTasks(tasks);
  const statuses = tasks.map(t => {
    return { _id: t._id, status: "pending" };
  });

  await del(`${deviceId}_tasks_faults_operations`);

  try {
    await connectionRequest(deviceId);
  } catch (err) {
    return {
      connectionRequest: err.message,
      tasks: statuses
    };
  }

  const sample = tasks[tasks.length - 1];

  // Waiting for session to finish or timeout
  await watchTask(deviceId, sample._id, timeout);

  const promises = [];
  for (const s of statuses) {
    promises.push(db.query("tasks", ["=", ["PARAM", "_id"], s._id]));
    promises.push(
      db.query("faults", ["=", ["PARAM", "_id"], `${deviceId}:task_${s._id}`])
    );
  }

  const res = await Promise.all(promises);
  for (const [i, r] of statuses.entries()) {
    if (res[i * 2].length === 0) {
      r.status = "done";
    } else if (res[i * 2 + 1].length === 1) {
      r.status = "fault";
      r.fault = res[i * 2 + 1][0];
    }
    db.deleteTask(r._id);
  }

  return { connectionRequest: "OK", tasks: statuses };
}

interface PingResponse {
  packetsTransmitted: number;
  packetsReceived: number;
  packetLoss: string;
  min: number;
  avg: number;
  max: number;
  mdev: number;
}

export function ping(host): Promise<PingResponse> {
  return new Promise((resolve, reject) => {
    exec(`ping -w 1 -i 0.2 -c 3 ${host}`, (err, stdout) => {
      if (err) return void reject(err);

      const m = stdout.match(
        /(\d) packets transmitted, (\d) received, ([\d.%]+) packet loss[^]*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/
      );
      if (!m) return void reject(new Error("Could not parse ping response"));

      resolve({
        packetsTransmitted: +m[1],
        packetsReceived: +m[2],
        packetLoss: m[3],
        min: +m[4],
        avg: +m[5],
        max: +m[6],
        mdev: +m[7]
      });
    });
  });
}

export async function putResource(resource, id, data): Promise<void> {
  if (resource === "presets") {
    await db.putPreset(id, data);
  } else if (resource === "provisions") {
    await db.putProvision(id, data);
  } else if (resource === "virtualParameters") {
    await db.putVirtualParameter(id, data);
  } else if (resource === "config") {
    await db.putConfig(id, data);
  } else if (resource === "permissions") {
    await db.putPermission(id, data);
  } else if (resource === "users") {
    delete data.password;
    delete data.salt;
    await db.putUser(id, data);
  }

  await del("presets_hash");
}

export function authSimple(snapshot, username, password): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const users = getUsers(snapshot);
    const user = users[username];
    if (!user || !user.password) return void resolve(null);
    hashPassword(password, user.salt)
      .then(hash => {
        if (hash === user.password) resolve(user.roles);
        else resolve(null);
      })
      .catch(reject);
  });
}