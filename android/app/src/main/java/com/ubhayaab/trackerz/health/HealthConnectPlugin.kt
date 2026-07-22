package com.ubhayaab.trackerz.health

// Capacitor plugin that exposes Android Health Connect reads to the Trackerz web
// app running in the WebView.
//
// WHY THIS EXISTS AT ALL: there is no Web API for Health Connect. A PWA, a TWA,
// or any browser tab cannot read sleep or step data - the data is only reachable
// from an Android process that holds the runtime health permissions. This file
// is that process.
//
// UNTESTED ON HARDWARE. Nobody who wrote this has an Android phone or a OnePlus
// watch. It compiles against the documented Health Connect API surface and every
// failure path returns a NAMED state rather than a silent zero, but the actual
// on-device behaviour (which records OnePlus Health writes, how it timestamps
// sleep stages, whether it backfills) has never been observed.
//
// Gradle dependencies this file needs (android/app/build.gradle):
//   implementation "androidx.health.connect:connect-client:1.1.0-alpha07"
//   implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1"
// and the module must apply the 'kotlin-android' plugin. Health Connect's own
// floor is API 26, so minSdkVersion must be >= 26 (see android/variables.gradle).
//
// THE ONE RULE IN HERE: never invent a number. Health Connect aggregates return
// null when there is no data for a bucket. null is dropped, never coerced to 0.
// A missing night must reach the UI as "no data", not as "you slept 0 hours".

import android.content.Context
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.Period
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {

    companion object {
        /** The Health Connect provider app package. */
        const val PROVIDER_PACKAGE = "com.google.android.apps.healthdata"

        /** Health Connect's own minimum. Below this the feature cannot exist. */
        const val MIN_SDK_INT = 26

        // availability() states - the JS side switches on these exact strings.
        const val AVAILABLE = "available"
        const val NOT_INSTALLED = "not_installed"
        const val UPDATE_REQUIRED = "update_required"
        const val UNSUPPORTED_DEVICE = "unsupported_device"

        // reject() error codes - the JS side switches on these exact strings.
        const val ERR_UNAVAILABLE = "unavailable"
        const val ERR_PERMISSION_DENIED = "permission_denied"
        const val ERR_BAD_RANGE = "invalid_range"
        const val ERR_READ_FAILED = "read_failed"

        /**
         * Every permission the app will ever ask for, in one place. Health Connect
         * shows the user exactly this list; asking for more than we read is a
         * privacy smell, so keep it in sync with the read methods below AND with
         * AndroidManifest.xml.
         */
        val READ_PERMISSIONS: Set<String> = setOf(
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(HydrationRecord::class),
            HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
        )
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val isoDate: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    // ---------------------------------------------------------------- availability

    /**
     * availability() -> { state, sdkInt, providerPackage, message }
     * state is exactly one of: available | not_installed | update_required |
     * unsupported_device. These are DIFFERENT problems with different fixes and
     * the UI says so.
     */
    @PluginMethod
    fun availability(call: PluginCall) {
        val state = availabilityState(context)
        val out = JSObject()
        out.put("state", state)
        out.put("sdkInt", Build.VERSION.SDK_INT)
        out.put("providerPackage", PROVIDER_PACKAGE)
        out.put("message", availabilityMessage(state))
        call.resolve(out)
    }

    private fun availabilityState(ctx: Context): String {
        if (Build.VERSION.SDK_INT < MIN_SDK_INT) return UNSUPPORTED_DEVICE
        return when (HealthConnectClient.getSdkStatus(ctx, PROVIDER_PACKAGE)) {
            HealthConnectClient.SDK_AVAILABLE -> AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> UPDATE_REQUIRED
            // SDK_UNAVAILABLE on a new-enough phone means the provider app is
            // simply not there - installable from the Play Store. Not a dead end,
            // and must not be reported as one.
            else -> NOT_INSTALLED
        }
    }

    private fun availabilityMessage(state: String): String = when (state) {
        AVAILABLE -> "Health Connect is available on this device."
        NOT_INSTALLED ->
            "Health Connect is not installed. Install it from the Play Store, then open " +
                "OnePlus Health and allow it to share sleep and activity with Health Connect."
        UPDATE_REQUIRED ->
            "Health Connect is installed but too old for this app. Update it in the Play Store."
        UNSUPPORTED_DEVICE ->
            "This device runs Android ${Build.VERSION.RELEASE}; Health Connect needs Android 8 or newer."
        else -> "Unknown Health Connect state."
    }

    // ---------------------------------------------------------------- permissions

    /**
     * requestPermissions() -> { availability, outcome, granted[], missing[],
     * allGranted, message }. Deliberately RESOLVES in every non-crash case
     * instead of rejecting, because "Health Connect isn't installed" and "you
     * tapped Deny" are different answers and the UI must tell them apart. outcome
     * is one of: granted | partial | denied | unavailable.
     */
    // Named requestHealthPermissions, not requestPermissions: the Capacitor
    // Plugin base class already declares requestPermissions()/checkPermissions()
    // (its own runtime-permission flow), and a same-name method here collides
    // with them at compile time. The JS bridge calls these names explicitly.
    @PluginMethod
    fun requestHealthPermissions(call: PluginCall) {
        val state = availabilityState(context)
        if (state != AVAILABLE) {
            call.resolve(permissionResult(state, "unavailable", emptySet(), READ_PERMISSIONS))
            return
        }
        scope.launch {
            try {
                val client = HealthConnectClient.getOrCreate(context)
                val already = client.permissionController.getGrantedPermissions()
                if (already.containsAll(READ_PERMISSIONS)) {
                    // Nothing to ask for - flashing the sheet would be noise.
                    call.resolve(permissionResult(state, "granted", already, emptySet()))
                    return@launch
                }
                val intent = PermissionController
                    .createRequestPermissionResultContract()
                    .createIntent(context, READ_PERMISSIONS)
                activity.runOnUiThread {
                    startActivityForResult(call, intent, "onPermissionsResult")
                }
            } catch (err: Exception) {
                call.reject(
                    "Could not open the Health Connect permission screen: ${err.message ?: err.toString()}",
                    ERR_UNAVAILABLE,
                    err
                )
            }
        }
    }

    @ActivityCallback
    private fun onPermissionsResult(call: PluginCall?, result: ActivityResult?) {
        if (call == null) return
        // The contract's parsed result is ignored on purpose: the authoritative
        // answer is what the permission controller reports afterwards. A user can
        // grant one record type and refuse another.
        scope.launch {
            try {
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                val missing = READ_PERMISSIONS - granted
                val outcome = when {
                    missing.isEmpty() -> "granted"
                    granted.intersect(READ_PERMISSIONS).isNotEmpty() -> "partial"
                    else -> "denied"
                }
                call.resolve(permissionResult(AVAILABLE, outcome, granted, missing))
            } catch (err: Exception) {
                call.reject(
                    "Could not read back which health permissions were granted: ${err.message ?: err.toString()}",
                    ERR_UNAVAILABLE,
                    err
                )
            }
        }
    }

    /** checkHealthPermissions() - same shape as requestHealthPermissions, no UI. */
    @PluginMethod
    fun checkHealthPermissions(call: PluginCall) {
        val state = availabilityState(context)
        if (state != AVAILABLE) {
            call.resolve(permissionResult(state, "unavailable", emptySet(), READ_PERMISSIONS))
            return
        }
        scope.launch {
            try {
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                val missing = READ_PERMISSIONS - granted
                val outcome = when {
                    missing.isEmpty() -> "granted"
                    granted.intersect(READ_PERMISSIONS).isNotEmpty() -> "partial"
                    else -> "denied"
                }
                call.resolve(permissionResult(AVAILABLE, outcome, granted, missing))
            } catch (err: Exception) {
                call.reject(
                    "Could not check health permissions: ${err.message ?: err.toString()}",
                    ERR_UNAVAILABLE,
                    err
                )
            }
        }
    }

    private fun permissionResult(
        state: String,
        outcome: String,
        granted: Set<String>,
        missing: Set<String>
    ): JSObject {
        val out = JSObject()
        out.put("availability", state)
        out.put("outcome", outcome)
        out.put("allGranted", outcome == "granted")
        out.put("granted", toJsArray(granted.map { shortName(it) }))
        out.put("missing", toJsArray(missing.map { shortName(it) }))
        out.put(
            "message",
            when (outcome) {
                "granted" -> "All health permissions granted."
                "partial" -> "Some health permissions were refused; only the granted ones can be read."
                "denied" -> "Health permissions were denied. Nothing can be read until they are granted."
                else -> availabilityMessage(state)
            }
        )
        return out
    }

    /** "android.permission.health.READ_SLEEP" -> "READ_SLEEP", for readable UI. */
    private fun shortName(permission: String): String = permission.substringAfterLast('.')

    private fun toJsArray(items: List<String>): JSArray {
        val arr = JSArray()
        for (item in items) arr.put(item)
        return arr
    }

    // ---------------------------------------------------------------- reads

    /**
     * readSleep(startIso, endIso) -> { sessions:[{ id, startIso, endIso,
     * durationMinutes, title, sourcePackage, stageCount }], count, droppedInvalid }.
     * A session with a zero/negative duration is DROPPED here rather than passed
     * on - the web layer must never be handed something it could round to
     * "0 hours slept".
     */
    @PluginMethod
    fun readSleep(call: PluginCall) {
        val range = parseRange(call) ?: return
        withClient(call) { client ->
            val sessions = JSArray()
            var dropped = 0
            var pageToken: String? = null
            do {
                val response = client.readRecords(
                    ReadRecordsRequest(
                        recordType = SleepSessionRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(range.first, range.second),
                        pageToken = pageToken
                    )
                )
                for (record in response.records) {
                    val minutes = Duration.between(record.startTime, record.endTime).toMinutes()
                    if (minutes <= 0) { dropped++; continue }
                    val item = JSObject()
                    item.put("id", record.metadata.id)
                    item.put("startIso", record.startTime.toString())
                    item.put("endIso", record.endTime.toString())
                    item.put("durationMinutes", minutes)
                    item.put("title", record.title ?: "")
                    item.put("sourcePackage", record.metadata.dataOrigin.packageName)
                    item.put("stageCount", record.stages.size)
                    sessions.put(item)
                }
                pageToken = response.pageToken
            } while (pageToken != null)

            val out = JSObject()
            out.put("sessions", sessions)
            out.put("count", sessions.length())
            out.put("droppedInvalid", dropped)
            out
        }
    }

    /**
     * readSteps(startIso, endIso) -> { days:[{ date, startIso, endIso, count }],
     * count, emptyBuckets }. Buckets with no data are SKIPPED - Health Connect
     * returns null for them and null is not zero.
     */
    @PluginMethod
    fun readSteps(call: PluginCall) {
        val range = parseRange(call) ?: return
        withClient(call) { client ->
            val days = JSArray()
            var emptyBuckets = 0
            val buckets = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL),
                    timeRangeFilter = localRangeFilter(range),
                    timeRangeSlicer = Period.ofDays(1)
                )
            )
            for (bucket in buckets) {
                val total = bucket.result[StepsRecord.COUNT_TOTAL]
                if (total == null) { emptyBuckets++; continue }
                val item = JSObject()
                item.put("date", bucket.startTime.toLocalDate().format(isoDate))
                item.put("startIso", bucket.startTime.atZone(ZoneId.systemDefault()).toInstant().toString())
                item.put("endIso", bucket.endTime.atZone(ZoneId.systemDefault()).toInstant().toString())
                item.put("count", total)
                days.put(item)
            }
            val out = JSObject()
            out.put("days", days)
            out.put("count", days.length())
            out.put("emptyBuckets", emptyBuckets)
            out
        }
    }

    /** readHydration(startIso, endIso) -> { days:[{ date, ml }], count, emptyBuckets }. */
    @PluginMethod
    fun readHydration(call: PluginCall) {
        val range = parseRange(call) ?: return
        withClient(call) { client ->
            val days = JSArray()
            var emptyBuckets = 0
            val buckets = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(HydrationRecord.VOLUME_TOTAL),
                    timeRangeFilter = localRangeFilter(range),
                    timeRangeSlicer = Period.ofDays(1)
                )
            )
            for (bucket in buckets) {
                val volume = bucket.result[HydrationRecord.VOLUME_TOTAL]
                if (volume == null) { emptyBuckets++; continue }
                val item = JSObject()
                item.put("date", bucket.startTime.toLocalDate().format(isoDate))
                item.put("ml", volume.inMilliliters)
                days.put(item)
            }
            val out = JSObject()
            out.put("days", days)
            out.put("count", days.length())
            out.put("emptyBuckets", emptyBuckets)
            out
        }
    }

    /**
     * readActiveCalories(startIso, endIso) -> { days:[{ date, activeKcal?,
     * totalKcal? }], count, emptyBuckets }. Both energy metrics are requested
     * because devices differ in which they write; each field is omitted
     * individually when its bucket is null.
     */
    @PluginMethod
    fun readActiveCalories(call: PluginCall) {
        val range = parseRange(call) ?: return
        withClient(call) { client ->
            val days = JSArray()
            var emptyBuckets = 0
            val buckets = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(
                        ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL,
                        TotalCaloriesBurnedRecord.ENERGY_TOTAL
                    ),
                    timeRangeFilter = localRangeFilter(range),
                    timeRangeSlicer = Period.ofDays(1)
                )
            )
            for (bucket in buckets) {
                val active = bucket.result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]
                val total = bucket.result[TotalCaloriesBurnedRecord.ENERGY_TOTAL]
                if (active == null && total == null) { emptyBuckets++; continue }
                val item = JSObject()
                item.put("date", bucket.startTime.toLocalDate().format(isoDate))
                if (active != null) item.put("activeKcal", active.inKilocalories)
                if (total != null) item.put("totalKcal", total.inKilocalories)
                days.put(item)
            }
            val out = JSObject()
            out.put("days", days)
            out.put("count", days.length())
            out.put("emptyBuckets", emptyBuckets)
            out
        }
    }

    /**
     * readHeartRate(startIso, endIso) -> { days:[{ date, avgBpm?, minBpm?,
     * maxBpm? }], count, emptyBuckets }. Present because the permission is
     * requested; asking for a permission the app never uses gets an app
     * distrusted.
     */
    @PluginMethod
    fun readHeartRate(call: PluginCall) {
        val range = parseRange(call) ?: return
        withClient(call) { client ->
            val days = JSArray()
            var emptyBuckets = 0
            val buckets = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX),
                    timeRangeFilter = localRangeFilter(range),
                    timeRangeSlicer = Period.ofDays(1)
                )
            )
            for (bucket in buckets) {
                val avg = bucket.result[HeartRateRecord.BPM_AVG]
                val min = bucket.result[HeartRateRecord.BPM_MIN]
                val max = bucket.result[HeartRateRecord.BPM_MAX]
                if (avg == null && min == null && max == null) { emptyBuckets++; continue }
                val item = JSObject()
                item.put("date", bucket.startTime.toLocalDate().format(isoDate))
                if (avg != null) item.put("avgBpm", avg)
                if (min != null) item.put("minBpm", min)
                if (max != null) item.put("maxBpm", max)
                days.put(item)
            }
            val out = JSObject()
            out.put("days", days)
            out.put("count", days.length())
            out.put("emptyBuckets", emptyBuckets)
            out
        }
    }

    // ---------------------------------------------------------------- plumbing

    /**
     * Gate every read behind availability + permissions, run it off the main
     * thread, and turn any throw into a NAMED error code. A read that cannot
     * happen must surface as an error the UI can explain - never an empty result
     * that looks like "you did nothing that day".
     */
    private fun withClient(call: PluginCall, block: suspend (HealthConnectClient) -> JSObject) {
        val state = availabilityState(context)
        if (state != AVAILABLE) {
            call.reject(availabilityMessage(state), ERR_UNAVAILABLE)
            return
        }
        scope.launch {
            try {
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                if (granted.intersect(READ_PERMISSIONS).isEmpty()) {
                    call.reject(
                        "Health permissions have not been granted, so nothing was read.",
                        ERR_PERMISSION_DENIED
                    )
                    return@launch
                }
                call.resolve(block(client))
            } catch (err: SecurityException) {
                // Thrown when a specific record type was refused. Distinct code so
                // the UI offers "grant permission" instead of "try again".
                call.reject(
                    "Health Connect refused the read: ${err.message ?: "permission denied"}",
                    ERR_PERMISSION_DENIED,
                    err
                )
            } catch (err: Exception) {
                call.reject(
                    "Health Connect read failed: ${err.message ?: err.toString()}",
                    ERR_READ_FAILED,
                    err
                )
            }
        }
    }

    /** Reads startIso/endIso off the call, rejecting loudly on anything unusable. */
    private fun parseRange(call: PluginCall): Pair<Instant, Instant>? {
        val startRaw = call.getString("startIso")
        val endRaw = call.getString("endIso")
        if (startRaw.isNullOrBlank() || endRaw.isNullOrBlank()) {
            call.reject("startIso and endIso are required.", ERR_BAD_RANGE)
            return null
        }
        val start = parseInstant(startRaw)
        val end = parseInstant(endRaw)
        if (start == null || end == null) {
            call.reject("startIso/endIso must be ISO-8601 timestamps.", ERR_BAD_RANGE)
            return null
        }
        if (!end.isAfter(start)) {
            call.reject("endIso must be after startIso.", ERR_BAD_RANGE)
            return null
        }
        return Pair(start, end)
    }

    private fun parseInstant(raw: String): Instant? = try {
        Instant.parse(raw)
    } catch (_: Throwable) {
        try { OffsetDateTime.parse(raw).toInstant() } catch (_: Throwable) { null }
    }

    /**
     * aggregateGroupByPeriod slices by calendar period, so it needs a LOCAL time
     * filter. "A day" here is the phone's local day - the same boundary the user
     * sees in OnePlus Health.
     */
    private fun localRangeFilter(range: Pair<Instant, Instant>): TimeRangeFilter {
        val zone = ZoneId.systemDefault()
        val start: LocalDateTime = LocalDateTime.ofInstant(range.first, zone)
        val end: LocalDateTime = LocalDateTime.ofInstant(range.second, zone)
        return TimeRangeFilter.between(start, end)
    }
}
